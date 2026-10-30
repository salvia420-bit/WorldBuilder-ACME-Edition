# Round 3: GPU-driven rendering for holtburger-web

**Date:** 2026-10-29
**Status:** plan, merged edition. It replaces stages 2 and 3 of `docs/2026-10-26-rust-scene-core.md`. This edition withdraws the contaminated bench 1, uses the quiet-box profiles and RC-BENCH v2, and folds in the verified WebAC/OpenAC lessons.
**Tags:** [M] measured, [C] read from code, [D] derived or estimated.
**Paths:** relative to `apps/holtburger-web` unless absolute. `scripts/perf-worker/` is at the holtburger repo root. `$RC` means `/mnt/wbterminal1/tmp/claude-scratch/perf/rc-rust-scene-core-2026-10-29/`.
**Reference-client citations** (from the lessons doc; only its verified claims are used, and nothing from its Appendix A):
- `L§n` is a section of `docs/2026-10-29-webac-openac-renderer-lessons.md`; `Ln` is its ranked lesson n (L§3).
- `WebAC:` paths are relative to `packages/renderer/src/` in `/mnt/wbterminal1/ac-refs/webac` (snapshot 2026-10-12). Its `docs/` and `tools/` paths are relative to that repo root.
- `OpenAC:` paths are relative to `src/AcDream.App/Rendering/` in `external/OpenAC`. Paths that start `AcDream.Core/`, `AcDream.App/` or `AcDream.UI.Abstractions/` are relative to `src/`. Commit hashes are repo-level.
- The lessons doc's "Our baseline" block (about 40 fps all-off, about 35 fps defaults, about 370 entity draws) came from the pre-correction brief. This plan uses §1 instead.

**How this plan was made:**
- Five read-only analyses: draw structure, GPU feature cost, platform, retail-shaped structures, and stage-1 lessons.
- Three candidate plans: WebGL2-max, WebGPU, and measure-first-budget.
- Three judges. They scored WebGL2-max 29 / 29 / 28.5, measure-first 28 / 30 / 27.5, and WebGPU 18 / 19 / 17.5.
- The WebAC/OpenAC lessons doc (six reader reports, two adversarial verification passes, one runnability scout).

The spine is WebGL2-max's build order. Grafted onto it:
- from measure-first: harness v2, the decision rules and the structure-ceiling probe;
- from WebGPU: the std430 row layout, the WebGPU probe and the go/no-go criteria;
- from the lessons doc: the measurement habits, the floored-frame pose skip, the retail 3x3 object ring, palette composites as array layers with per-instance state, the cross-cell interior buckets and shell cache, the occlusion re-check, particle buckets and shader motion, and the per-pass GPU budget governor.

---

## 0. Direction

**Owner direction (2026-10-29),** relaying the upstream holtburger author, whose renderer is entirely JS/Electron and runs at 100-500 fps on a ~4-year-old GPU:

> "You won't get good results copying AC's renderer. It was made for a CPU-dominant / fixed-function era. Don't over-index on acclient's renderer; use modern GPU-driven design based on your needs."

The bar stays the same: "the goal is to still appear the same visually."

Rules for round 3:

1. **Retail is the oracle for WHAT is drawn.**
   - This covers texel bytes, palettes and subpalette composition, ObjDesc part swaps, part frames (CSequence / `UpdateParts`), placement, surface state (`D3DPolyRender::SetSurface` as data), degrade tables, particle closed forms (`Particle::Update`, acclient.c:330313), portal/cell visibility (PView walk, outside_view, sidedness), and the object ring (`LScape::get_block_orient`, acclient.c:306681; see R3-1/R3-2).
   - These values are proven bit-exact, or within 1 f32 ulp, in node and cargo using the existing parity fixtures (`gen_<lane>.mjs`, math.rs).
2. **HOW it is drawn is ours.**
   - This covers batching, draw order inside a class, f32 composition on the GPU, texture arrays, row textures and culling granularity.
   - It is judged on visual parity: rc-eye stills at pinned sky and resolution, `rc_eye_diff.py` thresholds (§5 rule R4), and a batched owner eye test on the 1070.
   - It is not judged on bit-exact pixels. The round-1/2 bit-exact contract ruled out every draw-collapsing option (R4 §7 (c)/(d), R2 S7, walkInInstance).
3. **Rust's job.**
   - Rust keeps doing decode-once caches, retail kernels, and producers of flat buffers that reach the GPU in one upload per frame.
   - No new Rust code writes results back into per-object three.js state. Stage 1 showed the gather/write-back costs about what the arithmetic saves (`docs/2026-10-26-rust-rig.md` §2, `docs/2026-10-26-rust-entity-walk.md` §2). The one stage-1 lane that measured as a net loss on the 1070, `rustParticles`, is exactly this shape (§1.2).
4. **Platform.** Stay on WebGL2 and three r184 WebGLRenderer. WebGPU is decided later, on a measurement (step R3-12).
5. **"GPU-driven" in WebGL2 on ANGLE/D3D11** means:
   - plain or instanced draws, or vertex pulling;
   - RGBA32F row textures written once per frame from a flat buffer;
   - native-size texture arrays;
   - per-cell and per-entity visibility bits;
   - UBOs.

   There is no compute shader and no indirect draw.

   **ANGLE ground rule (L§3).** On Chrome/Windows, ANGLE's D3D11 backend turns every `WEBGL_multi_draw` range into a full `drawElements` and re-uploads the stage's whole default uniform buffer before each one, all on CrGpuMain (`scene3d/batched_runs.js:5-18`; `scene3d/pool_registry.js:34-40`). Settled Holtburg counted 1,921 `info.calls` = 5,838 real draws (07-15 [M]). So every step cuts draws with instanced runs (one `drawElementsInstanced` per distinct geometry) or merged geometry, never by adding ranges. OpenAC's multi-draw-indirect lesson carries over only as "fewer ranges".
6. **Perf flags go default-on only after a measured 1070 win** under §5. Seventeen flags went default-on on 10-26 with no 1070 performance data (`docs/2026-10-26-rust-scene-core.md:187`). The first quiet-box data (10-29, §1) shows the set as a whole wins; `rustParticles` is the one measured loss.

**Owner decisions this plan needs:**
- (a) Adopt the WHAT-exact / HOW-visual standard.
- (b) Adopt the perf-flag default-on rule (§5 R3).
- (c) Decide on `?partDegrade=on`. It is retail-correct (WHAT changes toward retail), so it is not a same-look change. WebAC ships retail per-part degrade on by default (L10; `WebAC: models/SetupModelRenderer.ts:130-137`).
- (d) Sign the per-tier targets after session M1.
- (e) List the looks that are sacrosanct at ultra. The 10-08 look pass covered clouds, SAO, grass, haze and paint light.
- (f) Ask the upstream author for a runnable build of his renderer for the A/B arm (§4). Until then, WebAC is the same-stack stand-in (M1c).
- (g) After the M1 `objRadius` arms: is an object radius above retail's 1 (today 4 = 81 landblocks vs retail's 9) a deliberate beyond-retail horizon? (L4; R3-1/R3-2.)
- (h) Which knobs a GPU-budget governor may turn at ultra, if R3-11 builds one (L11), and whether it may run alongside `adaptive_render_scale.js` (resolution is never a governor knob; R3-11).
- (i) Whether to run the optional OpenAC native A/B (M1d), which needs a .NET 10.0.3xx SDK install, a heavy publish, a 2.25 GB DAT copy to the 1070 box and a bake (L§5.2).

---

## 1. Where the 1070 frame goes now

### 1.1 Benches: bench 1 withdrawn, RC-BENCH v2 rep 1

**Bench 1 (`$RC/bench/`) is withdrawn.**
- It ran while Seagate Toolkit held one CPU core at 100% on the 1070 box. The owner had it stopped at ~23:00 on 10-29.
- `boxwatch.log` (`box/hbwho.ps1`) samples idle seconds, GPU 3D share, browsers and our Chrome. It does not sample CPU, so it did not see the hog.
- Session-to-session swing for one arm was 27-41 fps [M].
- Its readings (defaults 34.6 vs all-off 41.5 still fps, 2-17 s stalls in the flag-on arms) are not used anywhere in this plan. Neither is anything derived from them, such as "the drawExec=off arms were the worst stallers".

**RC-BENCH v2** (`$RC/bench2/hbbench.log`, `summary.json`): quiet box (after the hog was stopped), ultra, Holtburg, uncapped, 1280x720, fresh profile, GTX 1070 / D3D11 adapter string, 0 console errors in every arm that completed. Rep 1 of 3 [M]:

| Arm | still fps | still p99 ms | moving fps | tour fps | tour h100 | first-turn max ms | draws |
|---|---|---|---|---|---|---|---|
| defaults (17 scene-core flags on) | **45.1** | 36.6 | 45.7 | 42.9 | 21 | 997 | 1,117 |
| all-off (17 off) | **37.1** | 62.8 | 36.5 | 37.6 | 34 | 989 | 1,120 |
| `rustParticles=off` | 44.7 | 37.1 | 45.5 | 45.9 | 21 | 1,372 | 1,166 |
| `drawExec=off` | 38.8 | 47.0 | 39.9 | 39.9 | 33 | 686 | 1,110 |
| `rigMeshAlias=on` | 37.6 | 48.8 | 34.2 | 39.6 | 21 | 1,645 | 1,122 |

The worst tour frame in any v2 arm was 504 ms (`rigMeshAlias=on`); no arm had a multi-second stall [M].

**Arms that did not complete.** The v2 arm file (`scripts/perf-worker/arms-rc-rust-scene-core-v2.json`) has 8 arms; only the 5 above finished rep 1. `rc-terrainshared-ultra` (`hotTerrainShared=on`) failed with "page.evaluate: Target page, context or browser has been closed". The run then aborted on `spawnSync ssh ETIMEDOUT` while starting `rc-weaponfx-ultra` (`hotWeaponFxSync=on`), so that arm and `rc-grasscull-ultra` (`hotGrassCull=on`) have no reading (`$RC/bench2/hbbench.log`). Reps 2-3 must run all 8 arms. These three then have at most 2 reps, so none of them gets a verdict from v2; they stay owed (§1.6) until they have 3 valid reps.

**What the box was doing during v2:** boxwatch idle 0-22 s in every sample, `gpu3d_other` up to 16%, `browsers=1` [M]. So v2 does not pass rule V's idle gate (§5). It is the best data on file, not a valid arm set.

> **RC-BENCH v2 final (3 reps) — PLACEHOLDER. The orchestrator patches this table in when reps 2-3 finish. Nothing below depends on rep-1 deltas beyond what is stated as n=1.**
>
> | Arm | still fps median (min-max) | still p99 ms | moving fps median (min-max) | tour fps median (min-max) | tour h100 | draws | delta vs defaults | real under R1? |
> |---|---|---|---|---|---|---|---|---|
> | defaults (rep-1 snapshot: 17 flags incl. `rustParticles`) | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | — | — |
> | all-off | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
> | `rustParticles=off` | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
> | `drawExec=off` | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
> | `rigMeshAlias=on` | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
> | `hotTerrainShared=on` (no rep 1) | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
> | `hotWeaponFxSync=on` (no rep 1) | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
> | `hotGrassCull=on` (no rep 1) | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
>
> Box per rep (idle range, `gpu3d_other` max, background CPU): _tbd_. No A/A pair was run, so R1 noise = half of each arm's rep spread.
>
> **Comparability of reps 2-3 with rep 1.** hbbench loads `http://127.0.0.1:${PORT}/…` (`scripts/perf-worker/hbbench.mjs` `APP`), and v2 ran with `--port 8766`: the FROZEN snapshot `/mnt/wbterminal2/hb-snap/rc-20261029` (code + a real copy of `pkg/` taken at ~22:00 on 10-29, before the round-2 fixes, the 23:46 `rustParticles` flip and the 23:51 wasm). Reps 2-3 run on that same snapshot are rep 1's build and rep 1's defaults (`rustParticles` on, 17 flags), so they pool with rep 1 and the `rustParticles=off` arm stays a true one-lane-off arm; no pinning is needed there.
> - Any later bench on a NEW snapshot (the round-2 fixes, `rustParticles` off by default) must name every flag it depends on in its arms (e.g. `rustParticles=on` for a 17-on arm): an empty-flag defaults arm on the new build is the 16-on config.
> - Report rep 1 next to the reps 2-3 median as well as the 3-rep pool.

**Conclusions** (n=1 for the bench; the profile pairs in §1.2 are n=3):
- **Stage 1 as a set saves time on the 1070.** Main-thread busy −2.72 ms/frame mean over three interleaved profile pairs (−2.58 over pairs 2-3 alone; pair 1 is caveated in §1.2); LoAF-window fps +5.2 mean (+5.35 over pairs 2-3); v2 rep 1 +8.0 / +9.2 / +5.3 fps still / moving / tour, still p99 36.6 vs 62.8 ms [M]. All-off is not a faster baseline.
- **drawExec carries much of that.** `drawExec=off` (other 16 on) is −6.3 / −5.8 / −3.0 fps still / moving / tour at n=1 [M].
- **`rigMeshAlias=on` loses** 7.5 / 11.5 / 3.3 fps at n=1 [M]. It is already default off; its code goes (§2).
- **`rustParticles` is the one measured loss:** +1.13 ms main per frame in 3/3 profile pairs (§1.2). Turning it off moved still and moving fps by −0.4 / −0.2 (within noise) and tour by +3.0 at n=1. It has been default off since 10-29 (`scene3d/rust/particles.js:100-108`, `rustFlag("rustParticles", false)`; `docs/url-flags.md:2224`, "back to DEFAULT-OFF 2026-10-29"), and B0 keeps it off. It is re-flipped on only if reps 2-3, with the defaults arm of the frozen rep-1 snapshot (placeholder note above), show `rustParticles=off` losing by a real R1 delta (R3-0). R3-7 replaces it.
- The 27-41 fps one-arm swing is wider than any single-flag delta above. No single-flag verdict is final until reps 2-3 and an A/A pair exist.

### 1.2 Three interleaved profile pairs on the quiet box (`$RC/profile/`; pair 1 caveated)

Each run: 10 s CPU profile at the Holtburg orbit plus a 40 s LoAF window (`scripts/perf-worker/loaf-stalls.eval.js`), defaults and all-off interleaved, three pairs [M].

**Caveat on pair 1.** File times in `$RC/profile` put pair 1 at 22:54-22:58 (defaults-r1 boot / cpuprofile 22:54 / 22:55, alloff-r1 22:57 / 22:58). That is before the Seagate Toolkit stop: the orchestrator stopped it at ~23:00, after pair 1 (session log), so pair 1 ran with Toolkit holding one core at 100%. Pairs 2 and 3 ran at 23:04-23:14 on the quiet box. Pair 1 is therefore caveated, and the price list below is priced from pairs 2-3 with pair 1 shown in brackets. Every conclusion in §1.1 and §1.2 holds on pairs 2-3 alone.

| | pair 1 | pair 2 | pair 3 | mean | mean, pairs 2-3 |
|---|---|---|---|---|---|
| main busy ms/frame, defaults | 28.22 | 31.10 | 25.88 | 28.40 | 28.49 |
| main busy ms/frame, all-off | 31.21 | 31.66 | 30.48 | 31.12 | 31.07 |
| LoAF-window fps, defaults | 32.0 | 35.5 | 36.1 | 34.5 | 35.8 |
| LoAF-window fps, all-off | 27.2 | 32.9 | 28.0 | 29.4 | 30.45 |
| particles ms/frame, defaults (`rustParticles` on) | 2.34 | 2.54 | 2.44 | 2.44 | 2.49 |
| particles ms/frame, all-off (JS path) | 1.23 | 1.40 | 1.30 | 1.31 | 1.35 |

Price list, defaults vs all-off, ms per frame [M], mean of pairs 2-3 rounded half up, with pair 1 in brackets (`$RC/profile/{defaults,alloff}-r{1,2,3}.systems.txt`):
- draw loop 12.98 vs 13.81 [12.74 vs 14.09] (three's JS 7.90 vs 9.64 [7.75 vs 9.75]; our JS 2.19 vs 1.26 [2.26 vs 1.18]; GL natives 2.72 vs 2.72 [2.54 vs 2.93]);
- (program) 3.62 vs 4.33 [3.74 vs 4.42];
- projectObject 1.77 vs 1.82 [1.79 vs 1.88];
- frustum cull 0.31 vs 0.60 [0.28 vs 0.60];
- rig pose 0.20 vs 0.50 [0.20 vs 0.51];
- render-list sort 0.55 vs 0.83 [0.55 vs 0.79];
- material-variant sync 0.08 vs 0.26 [0.06 vs 0.26];
- billboards 0.02 vs 0.16 [0.02 vs 0.15];
- terrain VFX 0.54 vs 0.71 [0.55 vs 0.68];
- matrices 0.87 vs 1.07 [0.95 vs 1.05];
- animated scenery 0.19 vs 0.25 [0.21 vs 0.25];
- particles 2.49 vs 1.35 [2.34 vs 1.23].

What it shows:
- The flag set as a whole cuts main-thread work in 3 of 3 pairs, by 2.72 ms/frame on average (2.58 over pairs 2-3) [M].
- Every stage-1 lane in the price list saves time except `rustParticles` (+1.13 ms mean over 3 pairs, +1.14 over pairs 2-3) [M]. GL natives inside the draw loop are flat on pairs 2-3 (2.72 vs 2.72); the draw-loop saving is three's JS.
- Where the particle cost sits: the JS bridge's per-emitter marshalling, `scene3d/rust/particles.js` `tick` (today :702; :697 in the profiled build, cpuprofile lineNumber 696 0-based) 0.75 ms self and `dynamicInputs` (today :401; :396 in the profiled build) 0.43 ms, plus 0.43 ms in wasm [M]. The 10-29 flip comment added 5 lines above both. The bridge still runs the per-emitter JS (RP6 cull, cell gate, anchor resolve, route strings), then adds marshalling, a kernel and a copy-back into the instance buffers (`scene3d/rust/particles.js:401-835` today) [C].
- **Stalls:** no multi-second stall in 240 s of LoAF windows (6 runs x 40 s). Frames of 100 ms-1.5 s occur in both arms, more in all-off [M]. The 2-17 s stalls seen in bench 1 did not reproduce on the quiet box.

Shape of the defaults frame, mean of pairs 2-3 [M] (pair 1 in brackets):
- draw loop + projectObject + matrices + sort = 16.16 ms, 57% [16.03 ms, 57%];
- (program) 3.62 ms, 13% [3.74 ms, 13%];
- all game systems together ~6.2 ms, 22% [~6.1 ms, 22%].

Stage 1 could only work on the 22%.

Profiled ms per frame (~28) is above unprofiled p50 (~22 ms in v2) because of instrumentation overhead [M].

### 1.3 Draw census: what the 1,079 draws per frame are

Source: `$RC/boot2/holtburger-diag-census.json`, 60 frames, Holtburg orbit, ultra, defaults [M]. Executor outcomes per frame: fast 574.5, stateOnly (material/program switch) 375.2, full 20.8, empty 9.0, passThrough 99.8. The same RC-BOOT on the real driver: drawExec verify 28,888 + 86,202 checks with 0 fails, `texDemoted` 0, 0 console errors [M]. There are no shadow draws: CSM has been off on every tier since 10-17 (url-flags `csm` row).

| Kind (what builds it) | Draws/frame | Switches | Shape today | Priced draw cost [D] |
|---|---|---|---|---|
| Entity parts (`setup_rig.js:183-187`, `entities.js:5557-5640`) | 301.1 | 168.1 | one Mesh per (part, surface); one material + texture per (surface, palette) | ~1.39 ms |
| Cell props `cellstatic` (`cells.js:2456-2458`) | 288.5 | 67.7 | one Mesh per (cell, prop) | ~0.85 ms |
| Chunk buckets `static-batch-c-*` (`static_batch_x.js:2889`) | 143.0 | 71.2 | BatchedMesh per (3x3-LB region, surface) | ~0.63 ms |
| Occlusion proxies (`occlusion_cull.js`) | 86.5 | ~0 | one box + one query per cell/rig; 53 proxies, 33 hidden; ~51 queries/frame (377,750 / 7,447 frames) | ~0.17 ms + queries |
| Fused cell surfaces (`cells.js:2308-2367`) | 69.6 | 12.2 | one Mesh per cell, material array | ~0.19 ms |
| Post quads (unnamed passes) | 36.5 | — | ~25 addPass sites (`atmosphere_pipeline.js:1362-2028`) | small |
| Singletons / pools / atlas / building batch / building surface | 28 / 22 / 15 / 12 / 15 | ~45 | refusals of the batchers, page-tier pools | ~0.43 ms total |
| Animated scenery `anim-inst-*` (`animated_scenery.js:1244-1271`) | 19.0 | — | InstancedMesh per (setup, anim, part, surface) | ~0.1 ms |
| Sky / ParticlesOverClouds / FxGlow | 6.05 / 6 / 3 | — | | |
| Far patches / grass rings / terrain FX / terrain batch | 9 / 4 / 4 / 1 | — | | |

- Entity parts, cell props, proxies and fused surfaces together are 745.6 draws (69%) and ~248 of 375 switches (66%) [M].
- Their root cause is one texture per surface (per palette for entities), which means one three.js material per surface.
- Only 4 of 128 entity (geometry, material) pairs are shared, so plain instancing buys nothing while material follows the palette (`docs/HANDOFF-rust-scene-core-2026-10-26.md`). Once palettes become array layers (R3-4), sharing depends on geometry alone; the K4 inventory recounts it.
- `info.calls` undercounts real D3D draws: BatchedMesh ranges (§0 rule 5) and the terrain batch, which ANGLE loops once per in-view landblock (`scene3d/terrain_batch.js:86-93`). R3-0 reports range counts next to `info.calls`.
- Priced with R3 §5.10's per-draw costs, the whole draw loop is ~4.1 ms [D] (`/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/round3/kind_cost.py`). The per-draw prices on file disagree: ~10 µs per three.js draw (`scene3d/occlusion_cull.js:5-6`, 10-06), ~25 µs (`scene3d/cell_static_merge.js:8`), lane X 2.4-3.7 µs. WebAC's ~8 µs renderJs per draw is an Apple M3 Max figure [D, L§2]. These prices have mispredicted ms before (§6); R3-0 adds a dated 1070 calibration.
- Programs live: 176-182 on defaults (192 in v2's all-off arm). Async links: ~2.2-2.3k per session [M v2: 2,278 defaults, 2,176 all-off compiled].

### 1.4 Thread split (10-23 profiles, older flag set)

Source: `/mnt/wbterminal1/tmp/claude-scratch/perf/gg-grass-gpu-2026-10-23/on-r{1,2,3}-run.cpuprofile` and plan §1 [M].

**Main thread:** 20.6 ms per frame, 98% busy.

| Component | ms/frame |
|---|---|
| three draw loop | 6.98 (three JS 4.55, WebGL calls 1.49, our per-draw hooks 0.84) |
| (program) native | 3.93 |
| scene walk | 2.54 |
| misc per-frame JS | 1.12 |
| particles | 1.05 |
| entities + rig | 1.01 |
| terrain VFX / anim scenery | 0.85 |
| post passes | 0.62 |
| HUD | 0.57 |
| wasm | 0.57 |
| cells / portals / lighting | 0.54 |
| culling | 0.51 |

**Chrome GPU process (CrGpuMain):** 14.4-15.1 ms per present, of which WebGL is 9.7-10.1 and DOM/HUD raster 3.1-3.4. That is a ~67-69 fps cap once the main thread is faster, and no change that keeps the GL stream as-is can move it (R3 §0.2).

### 1.5 GPU time (stale: 10-17 only)

Source: `/mnt/wbterminal1/tmp/fps-agent/{anat1,anat2,gpucensus1,gpucensus2}.json`, `res/*.json`, LB 0xE632 outdoors. Settings then: CSM on, msaa 4 on every pass, log depth (no early-Z), cloudQuality ultra. World-pass timers include CPU submit time (`docs/2026-10-19-fps-review.md` finding 4).

| Item | 10-17 [M] | Today [D] |
|---|---|---|
| Terrain (1 draw) | 6.10-6.17 ms | lower with reversed-Z; 12-20 texture taps per near pixel [C] |
| Statics | 4.42-4.53 ms | |
| Cells (cellstatic + fused) | 1.6-1.9 ms | |
| Atmosphere pass (clouds, AP, SSAO composite) | 9.77-9.83 ms at cloud ultra; 4.27-4.64 ms with high march + 512² shadows | clouds + AP ~3.7-4.3 ms |
| SSAO / final pass / late particles | 0.24 / 0.39-0.40 / 0.09 ms | same |
| MSAA resolves | 1.95 ms at msaa 4 | 0.3-0.6 ms (msaa 2, world only) |
| Total | 28.27 ms/frame | ~15-18 ms once the CPU is fixed [D] |

Other measured references:
- GPU grass placement: CrGpuMain WebGL 14.3 → 10.0 ms; running p50 23.9 → 20.7 ms (`docs/HANDOFF-grass-gpu-2026-10-23.md`, 3 reps).
- `anim_scenery_gpu.js` removed a 1.3 ms/frame CPU loop.
- `statBatchChunk`: 24 → 66 fps at rest (url-flags.md:1989).
- Occlusion culling: 1,973 → 1,188 draws, 24.5 → 30.5 fps (10-06; before `interiorApertureCull` landed on 10-17).
- Hiding all interiors outdoors: 26.1 → 29.5 fps (`res/cells_F.json`).
- `statArrayMerge`: −23 draws = 0.0 ms (08-06).
- FXC: 0.5-1.7 s per pixel shader (`scene3d/async_link_guard.js:4-12`).
- `farFogSkyHz` readback: ~2.5 ms stall each time (url-flags.md:2047).

### 1.6 Still owed

- Any A/B on an idle 1070 (rule V) with ≥3 reps and an A/A pair. RC-BENCH v2 reps 2-3 are pending (on the frozen rep-1 snapshot, §1.1); no A/A arm is in it.
- The three v2 arms with no rep-1 reading: `hotTerrainShared=on` (browser closed), `hotWeaponFxSync=on` and `hotGrassCull=on` (run aborted on ssh ETIMEDOUT) (§1.1).
- Any run with the sky pinned (`hbbench.mjs` sets no `skytime`).
- Any run at the owner's resolution (`hbbench.mjs:56` hard-codes 1280x720; the owner plays at ~1920x1080).
- CrGpuMain and GPU ms per arm on today's defaults.
- The ANGLE per-range CrGpuMain price (P0 arm 2, `batchedRuns=off`).
- The never-measured built arms: `cellStaticMerge`, `statArrayMerge` re-arm, `partDegrade`, `cloudResScale`, `freezeWorldRoots` (its town number, url-flags row).
- `rustEntityWorld` with its projection half installed. Every earlier A/B ran the walk half only; the round-2 fix installs it from `scene3d/index.js` (fix_r2.json, lane R4).
- `objRadius` 1 / 2 / 4 on the 1070 (L4).
- The HUD raster's share isolated with `hud=none`.
- A reference renderer on the 1070. The upstream renderer is not on disk (the local clone `/home/wbterminal/holtburger` @629695a has only `apps/holtburger-cli` and `apps/holtburger-tools`). WebAC can run there today (§4.1).
- The 2-17 s stall attribution is **closed**: the stalls were seen only in the contaminated bench 1 and did not reproduce in 240 s of quiet-box LoAF windows. It reopens if a valid arm shows a frame ≥ 2 s.

---

## 2. What changes from the round-1/2 plan

| Item | Decision | Reason |
|---|---|---|
| Stage-1 default set (17 flags) | **Keep** default-on, except `rustParticles` | Quiet box: main −2.72 ms/frame mean (3/3 pairs; −2.58 over pairs 2-3), v2 rep 1 +8.0 still fps (§1). |
| `drawExec` + `drawExecRigs` | **Keep** default-on, frozen | Draw loop −0.83 ms [M, mean of pairs 2-3; −1.35 in caveated pair 1], all of it three's JS (GL natives flat). `drawExec=off` −6.3 / −5.8 / −3.0 fps still / moving / tour at n=1 [M v2]. Real-driver verify 28,888 + 86,202 checks, 0 fails, `texDemoted` 0 [M]. No more fast-path tuning. Re-run `tests/draw_exec.test.mjs` on any three upgrade. Its value shrinks as draws collapse. |
| S3.2 `drawExecRuns` | **Drop**, delete code | Shipped off for no gain. |
| S3.3 class-material snapshots, S3.4 Rust draw list | **Drop** | An exact executor issues the same GL stream, so CrGpuMain cannot move (R3 §0.2). S3.4 adds ~0.1 ms at best (R3 §5.10). |
| S3.5 frame/object UBOs, shared batching arena | **Reshape** into the R3-3 class materials | Changing shaders is the only route to fewer GL commands. Template: `lightUbo` (`scene3d/uniform_bind_patch.js:192-238`). |
| `hotDrawSort`, `hotMatVariant`, `hotCloudPush`, `hotTerrainTime`, `hotNightRamp` | **Keep** | Positive in pairs 2-3: sort 0.83 → 0.55, variant 0.26 → 0.08 ms [M] (pair 1: 0.79 → 0.55, 0.26 → 0.06). |
| `rustCull` + registry, `rustEntityCull`, `rustAnimSceneryGate`, `rustTerrainFx` | **Keep**, frozen | Small positives [M]; no further investment. |
| `rustRig` | **Keep**, reshaped | Becomes the producer of R3-4's part rows, with R3-2's floored-frame skip. `RigSet::pose_matrices` exists, is parity-pinned, and is unused by the bridge (`crates/holtburger-scene/src/rig.rs:185,411`; `src/scene_wasm/rig.rs:17`). |
| `rustAnimScenery` | **Keep**, reshaped | Becomes the row producer for `animSceneryBatch`. |
| `rustParticles` | **Default off** since 10-29 (`scene3d/rust/particles.js:100-108`; `docs/url-flags.md:2224`); B0 keeps it off; replaced by R3-7 | +1.13 ms main in 3/3 profile pairs, all in the JS bridge and wasm [M]. v2 rep 1 shows no fps loss from turning it off (§1.1). It is re-flipped on only if v2 reps 2-3, with the defaults arm of the frozen rep-1 snapshot, show `rustParticles=off` losing by a real R1 delta. The bridge goes after R3-7; the kernel stays as a cargo-tested CPU oracle for R3-7's readback until the JS parity generators cover the same fixtures. |
| `staticMatrixFreeze`, `anchorOffGraph`, `poolSizeToContent` | **Keep** | Structural and memory wins (R2). `staticMatrixFreeze` already freezes static draw nodes (singletons, LOD levels, batches, buckets, loners; url-flags `staticMatrixFreeze` row [C]), which covers WebAC's per-leaf freeze lesson (L12; `WebAC: utils/freezeStatic.ts:6-20`). |
| `rigMeshAlias` | **Drop**, delete code | `=on` −7.5 / −11.5 / −3.3 fps at n=1 [M v2]. Shared-Matrix4 hazard. Moot once part meshes leave the graph. |
| `rustEntityWorld` (`scene3d/entity_world.js`, 873 lines) | **Off; one M1b arm, then delete unless it wins** | Its only bench (bench 1) is withdrawn, and that build ran the walk half only. The round-2 fixes installed the projection and closed the stand-in retention leak and the shadow-memo cold record (fix_r2.json, lane R4). Gate the arm on `__entityWorld.stats().projections === 1`. R3-4 stage A2 removes its target either way. |
| Stall bisect (`scripts/perf-worker/arms-rc-bisect.json`, 11 arms) | **Do not run** | The stalls were seen only in the contaminated bench 1 (§1.6). LoAF windows stay in every anatomy arm. |
| `objRadius` default 4 | **Keep for now**; fix its fidelity text; M1 arms; owner decides (g) | `scene3d/object_radius.js:13-15` and `docs/url-flags.md:862` say retail draws objects across `mid_width = 11`. The decomp says retail builds statics, buildings and scenery only on the 3x3 full-detail ring (L4; R3-2). |
| R2 S0 census | **Keep** | Targeting tool; R3-0 adds owner rows and range counts. |
| R2 S2 rustWorld audit | **Keep off**, diagnostic only | It found a real default-on bug: the `objRadius` sticky pool-hide (`docs/2026-10-26-rust-world.md` §11.1). Lane W fixed it and added the `poolHideOrphan` audit category (fix_r2.json). Nothing gets built on it. |
| R2 S3 `rustWorldVis`, S4 `rustWorldLists`, S5 `rustWorldResidency`, S6 `rustWorldBake` | **Drop** | Residency costs ~0.05 ms/frame (R2). Moving bookkeeping into Rust removes neither draws nor nodes. S4 writes three's private multi-draw fields. |
| R2 S7 `rustWorldPools` (routing consolidation) | **Reshape** | Becomes the R3-5 interior batch now. Static-world class pools wait behind the R3-10 gate. |
| R4 §7 (c)/(d) entity merges | **Reshape** into R3-4 / R3-9 | Uses exact-size array pages, so nothing is resampled ((d)'s original risk). |
| Bit-exact contract for everything | **Reshape** | WHAT stays exact. HOW is judged by visual parity (§0, §5 R4). |
| Default-on rule (0 errors + same pixels) | **Reshape** | Perf flags also need a measured 1070 win (§5 R3). Correctness and look flags keep the old rule. |
| "57-62 fps after stage 3" projection | **Withdrawn** | It rested on per-draw prices lane X measured at 2.4-3.7 µs against an assumed 0.6. |
| Parity machinery (math.rs, `gen_<lane>.mjs`, mutation tests) | **Keep**, repurposed | It becomes the WHAT oracle for the GPU ports, plus a readback harness with f32 tolerance. |
| Census and diag tools (`__drawExec.census`, `worldGroupCensus`, `tools/rust_parity/profile_systems.py`, `hbbench`, `rc-eye`, `gpu_thread_split.py`, `loaf-stalls.eval.js`) | **Keep** | Round 3's targeting and scoring kit. |
| Decode-once Rust caches, wasm PView walk, EnvCell bake timing | **Keep unchanged** | The bake is the sole producer of the cell graph, so its timing is wire-visible (`docs/2026-08-13-indoor-outdoor-cell-architecture.md` §7). This constrains R3-5c. |

---

> **What all three clients share, and round 3 must solve without a reference** (L§1, L§2, L§4)
>
> - **One draw per part-surface for creatures.** WebAC and we draw it directly; OpenAC emits one one-instance MDI command per part-surface in-world (`OpenAC: Wb/WbDrawDispatcher.OrderedStream.cs:101-127`). → R3-4, R3-9.
> - **CPU part posing every frame** (all three). → R3-2 floored-frame skip, R3-4 pose rows. Our `scene3d/anim_scenery_gpu.js` is the only GPU-posed path among the three.
> - **Material clones for per-object fades and hooks** (`WebAC: models/MaterialOwnership.ts:5-24`; ours `_getOrCloneEntityMaterial` in `scene3d/entities.js`). OpenAC's per-instance state buffers are the one reference, and they rely on Vulkan storage buffers. → R3-4 state rows.
> - **CPU particle simulation** (all three; ours in Rust or JS). → R3-7.
> - **CPU visibility** (all three; we add GPU occlusion queries). → R3-5 bits, R3-6.
> - **No client culls or generates draw commands on the GPU.** → R3-12 decides whether WebGPU is worth it.
> - **No reference has a 1070-class run.** Their numbers are bounds, not targets (§5 rule R10).
>
> Validation follows the `anim_scenery_gpu` precedent: WHAT pinned in node/cargo, then readback, rc-eye and the owner's eye.

---

## 3. Round 3 steps, in order

**Effort scale** (agent-days): XS 0.5, S 1, M 3, L 8, XL 20.

**Laptop rule for every lane** (from `~/CLAUDE.md`, put verbatim in every agent prompt):

> "Parallel agents may read, edit and run TARGETED single tests only (`node test_x.mjs`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time."

Agent prompts also forbid commits, pushes and any self-armed git automation.

**1070 rule:** off-screen only, no sound, never touch the user's Chrome (match only by `--user-data-dir`), fresh `--user-data-dir` per arm-rep, one real-world tab at a time.

### Overview

| Step | Flag | Effort | Expected 1070 gain [D] | Look risk | Gate |
|---|---|---|---|---|---|
| R3-0 Harness v2 + clean baseline B0 | (scripts); `rustParticles` stays off (default off since 10-29); optional `occlusionCull=rigs` | S-M | −1.1 ms main (particles) [M profile]; makes every later claim [M] | none | v2 reps 2-3 (on the rep-1 snapshot, §1.1); round-2 fixes built and tested (done 10-29; full JS gate still running) |
| R3-1 Session M1: anatomy, floors, owed arms, probes, WebAC A/B | — | S + 2-3 sessions | none directly; settles 6 built arms and the objRadius question | none | R3-0 |
| R3-2 Cash what is built; delete below-noise code; pose skip; objRadius text; cheap CrGpuMain/hitch cuts | `cellStaticMerge`, `statArrayMerge`, `partDegrade`, `rigPoseSkip` (new), `farFogAsync` (new), `skipEmptyPasses` (new), `uploadWarmDraw` (new) | S | −0.2…−0.6 ms main; up to −2…−3 ms CrGpuMain (HUD); fewer hitch frames | low; partDegrade by design | M1 arms |
| R3-3 GPU batch kit, proven on animated scenery | `animSceneryBatch` | M | −0.05…−0.1 ms; de-risks R3-4/5 | low | lanes start during M1 |
| R3-4 Entity batch, stage A (+A2): palette layers, state rows | `entityBatch` | L | −1.1…−1.6 ms main; −1.5…−3 ms CrGpuMain | medium | kit + ceiling probe |
| R3-5 Interior batch per landblock (+ shell cache, optional lazy geometry) | `interiorBatch` | M-L (+S, +M optional) | −0.8…−1.2 ms main; −1…−2 ms CrGpuMain | medium | kit |
| R3-6 Retire the occlusion proxies (cell half re-check first) | `occlusionCull` (`=rigs`, then default flip) | S | −0.3…−0.4 ms main; GPU +0…0.5 ms | low | cell half: M1b/S2 arm; rest: R3-4 + R3-5 default-on |
| R3-7 GPU particles: shader motion, then fewer buckets | `gpuParticles` | M (+S) | −0.8…−1.0 ms main vs the JS path | low-medium; medium for the bucket merge | kit (+ R3-4 rows for rigs) |
| R3-8 Checkpoint M2 and re-route | — | S + 1 session | prevents wasted L/XL work | none | R3-4…R3-7 |
| R3-9 Entity stage B: one arena or instanced runs per class | `entityArena` | M | Holtburg −0.1…−0.3 ms; crowds −0.5…−1 ms | medium | M2: entity draws ≥ ~100 in crowds |
| R3-10 Static world: measure, then decide | (existing arms) | XS | measurement only this round | none | M1/M2 arms |
| R3-11 GPU-fill, post and pass levers; budget governor | `cloudResScale`, `bloomGlowPyramid`, `hudCanvas`, `projectOnce` (new), `gpuGovernor` (new) | M-L | up to −3 ms CrGpuMain; −1…−2 ms GPU; holds a frame-time target | eye-test class; governor by design | M2 says CrGpuMain or GPU binds |
| R3-12 WebGPU gate | — | S, + M if triggered | decision data | none | draws ≤ ~300 and CrGpuMain still binds |

Core path (R3-0 to R3-8, with R3-5b and R3-7b, without R3-5c) is about 32-42 agent-days, midpoint ~37 [D] (the draft's ~33 before the lessons were folded in), plus 5-6 owner/1070 sessions (M1 x2-3, S1, S2, M2).

**Projected round-3 end state** [D], Holtburg ultra at hbbench's 1280x720, if the main thread keeps binding:
- draws 1,079 → ~350-450 per frame; switches ~375 → ~130-170. The static world (~235 draws) is untouched this round.
- main thread −3.0…−4.3 ms below B0.
- CrGpuMain −3…−6 ms.
- From B0's ~45 fps still (v2 rep 1 defaults, before the rustParticles flip), that is roughly 50-60 fps standing.

GPU fill (~15-18 ms [D], unmeasured on today's settings) is the likely next ceiling. Every [D] here is recalibrated by the M1 structure-ceiling probe before L-sized work starts.

---

### R3-0. Harness v2 and clean baseline B0

**Flag:** none new in the product, except an optional XS value `?occlusionCull=rigs` (proxies for entity rigs only) so R3-6's cell-half arm can run in M1b. `rustParticles` has been default off since 10-29 (`scene3d/rust/particles.js:100-108`, `rustFlag("rustParticles", false)`; `docs/url-flags.md:2224`); `=on` stays testable.

**What:**
1. **B0.**
   - Run reps 2-3 on the same frozen snapshot as rep 1 (`hb-snap/rc-20261029` on :8766; §1.1 note), where the empty-flag defaults arm is still rep 1's 17-on config. Any arm on a new snapshot names its flags explicitly.
   - When RC-BENCH v2 reps 2-3 land (the orchestrator patches §1.1's placeholder table):
     - `rustParticles` stays default off (flipped 10-29, after rep 1). It is re-flipped on only if reps 2-3 show `rustParticles=off` losing to the rep-1-snapshot defaults arm by a real delta (rule R1) on any segment;
     - every other stage-1 default stays on;
     - `rigMeshAlias` stays off (code deleted in R3-2).
   - B0 includes the round-2 review fixes (fix_r2.json): lane W (the `objRadius` sticky pool-hide default-path pixel bug, and the `poolHideOrphan` audit category) and lane R4 (projection installed from `scene3d/index.js`, the stand-in retention leak, the shadow-memo cold record). Lane W's Rust changes were handed over uncompiled; the build-and-test step is **done** (10-29): `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/cargo-test-W.log` shows `test result: ok` for every test binary; `pkg/holtburger_web_bg.wasm` was rebuilt at 23:51 (`/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/wasm-release-b.log`); `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/suites-pkg-rel-20261029b.log:549-551` shows `[PASS] W objrPool pre-fix drift` and `rust world shadow: 156 passed, 0 failed`. The full JS gate (`/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/jsgate-20261029.log`) was still in progress at 23:57; B0 is tagged only after it passes.
   - Tag the commit plus flag set as **B0**. Every round-3 arm compares against B0. Until R3-0 lands, no new perf flag goes default-on.
2. **Harness v2.** Scripts only, under `scripts/perf-worker`:
   - **`hbbench.mjs`:**
     - add `skytime=13` and a fixed clear DayGroup to every URL;
     - add a per-arm window size, 1920x1080 (budget resolution) and 1280x720 (continuity with history), through `winsize.txt`;
     - before and after every segment, sample `box/hbwho.ps1` (`idle`, `gpu3d_other`, `browsers`) into the run JSON, **plus the top non-test processes by CPU**. Bench 1's Seagate Toolkit hog was invisible to boxwatch (§1.1);
     - assert the wasm is release (`harness/lib/wasm_profile.mjs`), `targetFps=0` and `adaptiveRes=off` (both already pinned at `hbbench.mjs:78`), `gpuGovernor=off` once that flag exists (R3-11; pinned the same way, so no bench arm is measured under a closed quality loop unless the arm says so), and the GTX 1070 adapter string;
     - **heading-binned sampling** on orbit and tour segments: per-frame `renderer.info` plus camera yaw, averaged over 12 heading sectors (L1; WebAC PERF.6, `tools/measure-perf.ts`). At one WebAC spot, point samples swung 93 / 239 / 929 draws (`WebAC docs/performance-budgets.md:239`);
     - a **renderJs wrapper** timing `renderer.render` per call (L1; `WebAC tools/measure-perf.ts:412-419`);
     - **multidraw range counts next to `info.calls`**: `__batchedRuns.frame()` sub-draws and issued counts, plus terrain-batch ranges (§1.3);
     - **render walks per frame, per pass**: how many full `renderer.render` walks run (composer passes `scene3d/atmosphere_pipeline.js:1362-1648`, direct-path sites `scene3d/index.js:3307-3380`) and which have empty layers (L6);
     - **server-state pin:** record the entity count and part-mesh census per arm, and flag an arm whose entity count differs from arm A by > 10% [D threshold]. In WebAC, creature spawns plus two extra streamed landblocks moved the census by 706 part meshes (L1; a SwiftShader count).
   - **`hbanatomy.mjs`** (separate run, fresh profile):
     - 10 s still + 10 s orbit under a Chrome trace (toplevel, gpu, gpu.angle, `devtools.timeline` categories), read with `gpu_thread_split.py` and `timeline_split.py`: main busy, plus CrGpuMain WEBGL / RASTER / PRESENT per present;
     - **whole-pass GPU timer queries** around each composer pass and each direct-path render, never nested. OpenAC found nested ranges read about a seventh of the real cost (0.16 vs 1.7 ms; `OpenAC: AcDream.App/Diagnostics/GpuStageProfiler.cs:15-20`, commit a712be21). Cost inside a pass is attributed by ablation (the M1b feature arms). This extends the existing whole-frame `?vfxGauge` query;
     - a `?vfxGauge=on&renderDiag=on` pass with `/mnt/wbterminal1/tmp/fps-agent/anatomy.js` and `gpucensus2.js` (GPU ms per pass and per draw class);
     - a 60-frame GL-command census (`glcensus.js` lineage);
     - **one census row per owner, with 300 m and 600 m distance buckets** (L1; WebAC builds its census by named ancestor with 300 m and 600 m distance buckets, `tools/measure-perf.ts:372-408`): entity part-surfaces, particle buckets, cell statics, cell surfaces, occlusion proxies, and each pool;
     - a **program-key diff** between arms (L1; WebAC's `--program-keys` diff found `numPointLights` churning, `WebAC docs/performance-budgets.md:188-213`). Our 176-182 live programs and ~2.3k async links per session make this the cold-compile check;
     - p50 / p95 / p99, GC time and an allocation figure per 5 s window (JS heap delta, `performance.memory.usedJSHeapSize` sampled at each window edge, next to the trace's GC events). OpenAC reports p50/p95/p99 plus allocations and GC per 5 s window (`OpenAC: AcDream.App/Diagnostics/FrameProfiler.cs`);
     - a LoAF window (`scripts/perf-worker/loaf-stalls.eval.js`) in every arm, as standing hitch attribution;
     - a **dated 1070 µs-per-draw calibration** (renderJs ms ÷ draws, and CrGpuMain WEBGL ms ÷ real D3D draws), replacing the four disagreeing figures in §1.3.
   - **`hbsweep.mjs`:** in-session ABAB sweeps, 8 s windows x3, of live toggles that do not relink programs (`__setRenderScale` 1 / 0.5 / 0.25, cloud resolution and quality, layered haze, light shafts, SSAO).
   - **`hbreport.py`:** applies the §5 rules and reports, per segment, the median, the min-max, the A/A noise, the binding thread, the heading-binned draws and ranges, and a verdict.

**Why + evidence:**
- Session-to-session swing for one arm of 27-41 fps (§1.1).
- A CPU hog on the box went unseen by boxwatch (§1.1).
- A person active during nearly every arm (v2 idle 0-22 s).
- The sky is not pinned, so cloud, aerial-perspective and night-ramp cost follow the server clock.
- The resolution is 720p, not the owner's 1080p.
- No arm reads CrGpuMain or GPU time.
- Point-sampled draw counts swing with camera heading (L1).
- `rustParticles` is +1.13 ms in 3/3 profile pairs (§1.2).

**Expected 1070 gain:** −1.1 ms main thread [M, profile]. No fps claim for the particle flip: v2 rep 1 moved still / moving / tour by −0.4 / −0.2 / +3.0 fps (n=1). No fps claim for the remaining flags until M1.

**Look risk:** none. Particles return to the JS path that shipped before 10-26. RNG streams already differ by design.

**Proof:**
- `hbreport.py` unit runs against the stored `$RC/bench`, `bench2` and `profile` JSON. It must reproduce today's numbers, mark bench 1 CONTAMINATED (from a manual box-event list, since its JSON has no CPU samples) and mark v2 INVALID under rule V's idle gate. Agents run these as targeted tests.
- `node --check` on every `.mjs`.
- `?occlusionCull=rigs`, if built: a targeted node test that cell candidates get no proxy and rig candidates still do.
- Orchestrator: the capped-build full JS gate after the flip (`jsgate-20261029.log`, still running at 23:57 on 10-29) passes, and a bare-URL boot with 0 errors.

**Effort:** S-M (2.5-4 days of script work, parallel lanes, no browsers on the laptop).

### R3-1. Session M1: anatomy, floors, owed arms, probes, WebAC A/B

**Flag:** none.

**What:** two or three owner-scheduled 1070 sessions under §5, prepared as `docs/reengineering/queue-1070/batch-R3-M1-<date>.json` (schema `hb-1070-queue-v1`) with the decision rules copied in before the run. Arms are listed in §4. They cover:
- the thread anatomy at 1080p and 720p, with whole-pass GPU timers;
- the floor ladder (`nullRender=1`, `hud=none`, low / mid / high);
- the six owed built arms: `cellStaticMerge`, `statArrayMerge`, `partDegrade`, `cloudResScale`, `freezeWorldRoots`, `rustEntityWorld` (projection installed); plus the `batchedRuns=off` range price (R3-10);
- **`objRadius=1`, `2` and `4`** (L4), interleaved, parked at Holtburg and at a hilltop. Retail builds statics, buildings and scenery only on the 3x3 full-detail ring (decomp in R3-2). WebAC ships that ring: its Holtburg census went statics 787 → 223, buildings 60 → 16, scenery instances 32,066 → 383 (`WebAC docs/performance-budgets.md:180`). OpenAC goes beyond retail on purpose with `ObjectRingLimit = 4` (`OpenAC: Walk/RetailFrameWalk.cs:50, :145`), which is where our default of 4 came from (`scene3d/object_radius.js:14`). The arms price the ring; the owner decides (decision (g));
- **`partDegrade=on` at a crowd spot** as well as Holtburg (L10). Retail stops drawing a human's body parts beyond about 134 m (`scene3d/part_degrade.js:22-24`); the saving depends on the crowd;
- `occlusionCull=rigs` vs default, if the R3-0 value landed (R3-6, L8);
- GPU-feature prices;
- **M1c, the WebAC same-stack A/B** (§4.1), not blocking;
- three probes:
  - **Structure-ceiling probe** (`scripts/perf-worker/structure-ceiling.eval.js`). Boot with `?renderOnDemand=1`. At the bench pose, run its own rAF loop in four variants, 10 s each, ABAB:
    - V0: today's world scene without the composer;
    - V1: visible plain meshes merged per existing material;
    - V2: merged per blend class with one flat material;
    - V3: V0 plus the full composer.
    It reads main render ms, CrGpuMain WEBGL ms and GPU ms, restores everything when done, and never ships. Limitation: `mergeGeometries` cannot merge BatchedMesh, instanced, grass or row-driven content, so V1/V2 cover the plain-mesh populations (entity parts, cell props, fused cells, proxies). That is exactly the population R3-4/R3-5 target.
  - **Layer-mip readback probe:** proves on the real 1070 driver that a texture copied into an array layer by the R3-3 path reads back byte-equal, level by level, to today's 2D texture.
  - **WebGPU capability probe** (standalone `tools/webgpu_probe/`): adapter features and limits (`maxTextureArrayLayers`, storage-buffer limits, `texture-compression-bc`, `timestamp-query`, whether `chromium-experimental-multi-draw-indirect` is present); 1,000 `drawIndexed` vs a render bundle vs 1,000 WebGL2 `drawElements` on main and GPU-process ms; Dawn trace category names; `createRenderPipelineAsync` time for one terrain-sized shader.

**Output:** **budget ledger v0**: ms per thread per feature and structure, per tier and resolution, plus which thread binds at each tier, plus the M1c reference bounds. The owner signs per-tier targets from it.

Starting proposal: ultra ≥ 60 fps standing and moving at 1080p, high ≥ 90, both with 0 frames over 100 ms standing or moving. These targets are reset by what M1 shows is feasible.

**Why + evidence:**
- Every frame-split number we have is from 10-23 (a different flag set) or 10-17 (GPU, stale settings), apart from the 10-29 main-thread profiles.
- Draws removed x µs per draw has mispredicted ms three times (`docs/HANDOFF-gpu-resident-statics-2026-10-22.md` §9, walls 29/107/137).
- The probe calibrates the L-sized steps on our own content before they are built.
- Our default `objRadius` keeps 81 object landblocks against retail's 9 (L4), and the comment that justified it is wrong (R3-2).

**Expected 1070 gain:** none directly. It sets the order (rule R5), settles six built arms as keep or revert with no new code, and prices the object ring.

**Look risk:** none (measurement). `objRadius=1` is high-risk if adopted: buildings and trees beyond the neighbouring landblocks leave the horizon (L4). That is decision (g), not an M1 outcome.

**Proof:** every arm valid under rule V, A/A noise reported, ledger generated by `hbreport.py` from the run JSON.

**Effort:** S to prepare, plus 2-3 owner sessions (~3-4 h each; see §4 for the arm budget).

**Laptop:** the probe scripts get one SwiftShader tab check by the orchestrator (`?wireframe=1`, small window), for script correctness only.

### R3-2. Cash what is built, delete what measured below noise, pose skip, objRadius text, cheap CrGpuMain and hitch cuts

**Flags:** `cellStaticMerge`, `statArrayMerge`, `partDegrade` (all existing); `rigPoseSkip`, `farFogAsync`, `skipEmptyPasses`, `uploadWarmDraw` (new), plus one new flag per fix that the worker-wait audit produces. Each new perf or hitch flag is built default off and flips only after its 1070 arm wins under §5 R3 (§0 rule 6). The HUD diet needs no flag under the HUD rule; it gets an owner glance.

**What:**
- **Flip on whichever built arms win in M1** under §5 R3:
  - `?cellStaticMerge`: one draw per (EnvCell, material); `scene3d/cell_static_merge.js`, built 10-06, node-tested, never measured. L5(a): "run the 1070 look check and ship it". By the module's own count it takes ~351 cell-static draws to ~200 (cell, material) pairs (`scene3d/cell_static_merge.js:6-9`). Its own gate is the look check: interiors through doorways at Holtburg, a dungeon room, a lantern's light (`:22-23`).
  - `?statArrayMerge` re-arm: measured 0.0 ms on 08-06, before `staticEarlyOut` and `batchedRuns` landed.
  - `?freezeWorldRoots` if its town arm wins (L12). It freezes 7 containers, which is not WebAC's per-leaf freeze; our per-leaf freeze is `staticMatrixFreeze`, already default-on.
- `?partDegrade=on` only as owner decision (c). It is retail `CPhysicsPart` deg_level / `GfxObjDegradeInfo`, so distant NPC parts stop drawing, as in retail. Keep our throttled interval; do not copy WebAC's per-frame `matrixWorld.decompose` of every part (`WebAC: models/DegradeLod.ts:698`) (L10).
- **`?rigPoseSkip` (new): skip re-posing when the floored frame has not changed** (L2).
  - Retail poses whole keyframes: `CSequence::get_curr_animframe` takes `_floor(this->frame_number)` (acclient.c:339745-339758). We pose `f = globalFrame | 0` (`scene3d/motion/motion_sequence.js:151`). Neither WebAC nor we skip work when the floored frame is unchanged.
  - Keep a per-entity dirty key of (motion descriptor, floored frame, in-place mode). When it is unchanged, skip the `rustRig` pose call and the part-local writes. The root transform still updates.
  - In R3-4 an unchanged key also means no pose-row write.
- **Correct the object-ring fidelity text** (L4). `scene3d/object_radius.js:13-15` says retail draws objects "across the whole `mid_width = 11` grid"; the `objRadius` row at `docs/url-flags.md:862` repeats it and adds that `?objRadius=off` restores "retail's full-ring objects". The decomp says otherwise:
  - `LScape::get_block_orient` gives size 1 only at Chebyshev distance ≤ 1 (acclient.c:306681 ff.);
  - `CLandBlock::init_buildings` (:352134) and `CLandBlock::init_static_objs` (:352811) are gated on `side_cell_count == 8`, and `get_land_scenes` sits inside that gate (:352887-352888);
  - `update_block` calls `notify_change_size` when a block leaves full detail (:308183-308185), which destroys statics and buildings (:352430-352438).

  The text should say: retail builds statics, buildings and scenery on the 3x3 full-detail ring (9 landblocks); our default 4 (81 landblocks) is a beyond-retail horizon copied from OpenAC's High near tier; `off` means the full 11x11 residency ring, which is not retail either. The default does not change until decision (g).
- **Delete** the `rigMeshAlias` and `drawExecRuns` code, and `rustEntityWorld` unless its M1b arm wins under R3. That is ~1.2k lines of three-internal mirroring in the files R3-4 touches if `rustEntityWorld` goes, ~0.3k otherwise [D] (`scene3d/entity_world.js` alone is 873 lines [C, `wc -l`]).
- **`?skipEmptyPasses` (new): skip empty passes** (L6, step 3): if R3-0's walk count finds composer passes or direct-path renders whose layers are empty on a given frame, skip their `renderer.render` call. Each full render re-runs `updateMatrixWorld`, `projectObject` and the sort (2.39 ms on the old stack: 0.78 matrix walk, 1.29 projectObject, 0.32 sort; `docs/2026-10-26-rust-residency-design.md:276`). Today, mean of profile pairs 2-3: projectObject 1.77, matrices 0.87, sort 0.55 ms/frame summed over all walks [M] (caveated pair 1: 1.79 / 0.95 / 0.55).
- **HUD diet**, if M1's `hud=none` arm moves CrGpuMain by ≥ 1 ms: stop the continuous CSS animation on the vitals orbs and redraw the radar at ≤ 10 Hz (improvement-hunt B15). Also audit the 2D canvases: only 3 of our 29 `getContext('2d')` sites set `willReadFrequently: true`, which WebAC defaults on (`WebAC: ui/CanvasBacking.ts:26-34`). Its effect on the 1070 is unmeasured [D]; try it inside the same HUD arm, not as a blanket change.
- `?farFogAsync`: read the far-fog sky colour through a PBO + `fenceSync` instead of the 1 Hz synchronous readback.
- **Hitch cuts** (L12):
  - **`?uploadWarmDraw` (new): play-time upload draw.** WebAC draws each newly arrived subtree once into a 1x1 scissor with an unlit override material (`WebAC: scene/RendererWarmup.ts:49-57`). With a fixed light count and warm-up, its turning max frame went from 208 ms to 18.5-18.7 ms (`WebAC docs/performance-budgets.md:205-210`). Our ledger item render-perf-5 shipped only the zero-visual part. This fixes hitches, not fps.
  - **No whole-job waits on workers.** Audit how bake-worker results are adopted for any frame-thread wait on a whole job. OpenAC's per-read content gate cut frame-thread waits from 36.9 ms to 0.3 ms (commit 97bc65e4). Any fix the audit produces is treated like the upload draw: its own flag, default off, and an S1 hitch arm (first-turn max, h100) before it flips.

**Why + evidence:**
- cellstatic is 288.5 draws/frame with 67.7 switches [M census].
- Chunk buckets switch 71.2 times per frame, once per distinct surface [M].
- Rig pose is 0.20 ms/frame at Holtburg in each of the three profile pairs [M]; the node rig bench (100 rigs x 17 parts, pose plus scene walk) costs 1,392 µs per frame on the laptop (`docs/2026-10-26-rust-rig.md:38`) [M]. The pose share of that is the ceiling for the skip.
- HUD raster is 3.1-3.4 ms of CrGpuMain per present [M 10-23].
- The far-fog readback blocks ~2.5 ms every second [M].
- 100 ms-1.5 s frames occur in both profile arms [M]; first-turn max is 686-1,645 ms in every v2 arm [M].

**Expected 1070 gain** [D]:
- cellStaticMerge: −70…−110 draws (our census), or ~−150 (module comment, L5); −0.2…−0.4 ms main.
- statArrayMerge, if the 08-06 wall is gone: −55…−60 switches, ~−0.35…−0.4 ms.
- rigPoseSkip: ≤ 0.2 ms main at Holtburg; more in crowds. The skip rate depends on each animation's DAT framerate relative to the display rate.
- Empty-pass skip: up to ~1-2 ms per avoided full walk, scaled from the 2.39 ms figure (L6); zero if no pass is empty.
- HUD diet: up to −2…−3 ms CrGpuMain.
- farFogAsync: removes a ~2.5 ms stall per second.
- Upload draw and worker audit: hitch metrics (first-turn max, h100), not fps.

**Look risk:**
- cellStaticMerge: low. Identical world-space triangles; draw order inside a cell changes (cellStaticBias z-ties).
- partDegrade: visible by design (retail behaviour).
- rigPoseSkip: none if the key is complete.
- objRadius text: none (documentation only).
- Empty-pass skip: none if the skipped pass truly drew nothing.
- HUD: orb animation look.
- Upload draw: none if it stays inside a 1x1 scissor.

**Proof:**
- Targeted node tests (`cell_static_merge`, the statics array-merge harness with 115 checks, `part_degrade`, `test_object_radius.mjs`).
- `rigPoseSkip`: the rig parity tests pass with the skip on, and a mutation that drops any one key field makes them fail.
- Empty-pass skip: a node test that a skipped pass had zero renderable items in its layers. S1 arm: `skipEmptyPasses` on/off x3 (main busy, still / moving / tour fps).
- `uploadWarmDraw`: a node test that the warm draw is scissored to 1x1 and uses the unlit override material; an rc-eye no-change pair (Holtburg, on vs off); S1 arm on/off x3 scored on first-turn max and h100.
- Worker-wait fixes, if any: the same shape (a targeted node test of the new adoption path, then an S1 hitch arm x3).
- rc-eye pairs: Holtburg doorways, room a9b40121, one dungeon room, lanterns at hour 22.
- `window.__cellStaticMerge` totals.
- One orchestrator full JS gate after the deletions.

**Effort:** S (1.5-2.5 days).

### R3-3. GPU batch kit, proven first on animated scenery

**Flag:** `animSceneryBatch` (the kit itself has no flag; its consumers do).

**What:** one shared substrate in `scene3d/gpu_batch/`. Lanes K1-K3 start on the laptop during the M1 sessions; the kit is needed whatever M1 says.

1. **Array pages** (K1).
   - Native-size `sampler2DArray` pages per (width, height, format: RGBA8 / BC7), preallocated from the census with x1.5 growth, with layer free lists and refcounts. OpenAC's composite arrays are about 4 MiB with at most 64 layers each (`OpenAC: CompositeTextureArrayCache.cs:236-240`), a starting point for page size [D].
   - **Mips must be the driver's mips.** Today's surface textures get driver-generated mips (`scene3d/adapter.js:1136` `surfacePixelsToTexture` sets `generateMipmaps = true` at :1178; `scene3d/static_atlas.js:490,524`). An RGBA8 layer is therefore admitted like this:
     - upload to a scratch 2D texture of the same size and internal format;
     - call `gl.generateMipmap` on it (the same ANGLE/D3D11 path as today);
     - copy each level GPU-side into (layer, level) with `framebufferTexture2D` + `copyTexSubImage3D`.
   - BC7 layers copy their baked levels with `compressedTexSubImage3D`.
   - Never use r184's `layerUpdates` followed by `generateMipmap`, which re-mips every layer of the array (pipeline-default-on §10).
   - Rust-built mips are rejected: they are not the driver's mips and would change the look of every layer.
   - Same sampler state as today: LinearMipmapLinear, the adapter's max anisotropy, Repeat.
2. **Layer state table** (K1). One RGBA32F texel row per layer carrying retail `SetSurface` as data:
   - alpha-test ref, including the parityV2 ClipMap ref and the paletted-texture ref as `_applyPalettedSurfaceRenderState` sets it today (WebAC keeps a separate threshold for palettized textures, `WebAC: models/MaterialFactory.ts:98-103`; L3 look risk);
   - opacity = 1 − translucency;
   - flat emissive luminosity;
   - additive (fog off), two-sided and blend-class flags.
3. **Row textures** (K2).
   - Rows are 16-byte vec4 rows in std430 layout (from the WebGPU plan), so the same bytes would later serve as WebGPU storage buffers.
   - They go into RGBA32F textures, filled from one flat wasm `Float32Array` with one `texSubImage2D` per frame (the `anim_scenery_gpu.js` method).
   - A `#define` redirect of `instanceMatrix` / the model matrix keeps every existing `onBeforeCompile` patch working (light clamp, fog, POM, VFX, `lightUbo`).
   - Normal-matrix rows are written alongside.
   - A zeroed row collapses its vertices: a hidden part, a hidden cell, a culled object.
4. **Per-frame upload caps** (L12). One byte-denominated per-frame budget covers both kinds of upload the lesson names, so a streaming burst spreads over frames instead of hitching:
   - texture uploads: layer admits (`texSubImage3D`, `copyTexSubImage3D`, `compressedTexSubImage3D`) and row-texture growth;
   - geometry (`BufferAttribute`) uploads of kit consumers: R3-4's merged entity geometry, R3-5's per-LB interior batches appended at bake, and R3-3's own anim-scenery geometry. A new or grown kit geometry becomes visible, and so uploads, only when the frame's budget has room; until then the consumer keeps its previous state (the legacy meshes, or the batch before the append). Appends upload only the new range (`BufferAttribute.addUpdateRange`).

   The static pools rebuilt on LB crossings are not kit consumers and stay outside the cap this round (R3-10 builds nothing in the static world); S1 and S2 record their upload bytes per crossing so round 4 can decide.

   OpenAC caps GPU upload at 8 MiB per frame (`OpenAC: AcDream.App/Streaming/StreamingWorkBudgetOptions.cs:17-25`) and composite uploads at most 16 uploads and 8 MiB per frame (`DefaultMaximumUploadsPerFrame = 16`, `DefaultMaximumUploadBytesPerFrame = 8 MiB`; `OpenAC: CompositeTextureArrayCache.cs:238, :240`). Start at 8 MiB (textures and geometry together) and 16 layer admits per frame [D]; S1 measures.
5. **Precision.** Per-entity and per-landblock origins. Camera-relative offsets are computed in f64 on the CPU each frame (f32 ulp at x ≈ 32.4 km is ≈ 3.9 mm).
6. **Class materials** (K2).
   - `{opaque, alpha-test, translucent, additive} x {lit, baked-light} x {FrontSide, DoubleSide}`, as `MeshStandardMaterial` carrying the base `onBeforeCompile` chain plus the map → array redirect, with `customProgramCacheKey` + `'|hbBatch1'`.
   - Draws are plain or instanced, never BatchedMesh multidraw ranges (§0 rule 5).
   - A frame/camera UBO on the `lightUbo` template.
   - Each class is registered in `shader_prewarm.js` so FXC compiles happen behind the loading screen.
7. **Facade:** a raycast over batch slices for picking and film (the vertex-pull spike's raycast lesson).
8. **First consumer, `?animSceneryBatch`** (K3): merge each animated setup's parts into one geometry with a per-vertex pose row (today the row is per geometry), plus array layers where surfaces differ.

**Why + evidence:**
- Every large draw kind has the same root cause (§1.3).
- Proven pieces: `anim_scenery_gpu.js` (removed a 1.3 ms/frame loop [M]), `static_atlas` `makeArrayMaterial` (`static_atlas.js:737`), GPU grass (−4.3 ms CrGpuMain WebGL [M]), and the vertex-pull spike (pixel-identical on SwiftShader, `docs/vertex-pull-spike-2026-10-22.md`).
- Animated scenery is 19 draws/frame; setup 0x20004b0 alone takes 13 [M census]. Rigid parts and the same pose math make it the cheapest real population to prove the kit on.
- Of the three clients, only ours poses instances in the vertex shader (L§1); neither reference has a kit like this to copy.

**Expected 1070 gain:** anim-inst 19 → ~4-6 draws, −0.05…−0.1 ms [D]. The real value is that session S1 measures row-upload cost, layer-admit cost and first-turn compile stalls on the real driver before R3-4 depends on them. Fewer live programs over time also means fewer cold stalls.

**Look risk:** low. Texels are byte-identical and the pose math is the same. Draw order among a setup's parts changes; coplanar ties are rare in critters.

**Proof:**
- Node: page allocator, refcount/eviction invariant, upload-cap scheduler (texture and geometry bytes against one budget; a deferred geometry stays invisible until admitted), row packing, and state-table rows equal to `_applyPalettedSurfaceRenderState` / `_materialFromFlags` outputs on real portal.dat surfaces.
- Orchestrator: new `harness/glsl_smoke/gpu_batch_smoke.mjs` on SwiftShader, legacy vs kit:
  - layer readback byte-equal;
  - frame max channel difference 0 on texel arms, ≤ 1/255 on the f32-composition arm.
- The M1 layer-mip readback probe on the 1070.
- Laptop Holtburg boot with 0 errors.
- S1 arm: `animSceneryBatch` on/off x3, plus async-link counts, the program-key diff and the first-turn hitch.

**Effort:** M (4-6 days). Lanes K1 (pages + state table + upload caps), K2 (rows + class materials + prewarm), K3 (anim-scenery consumer), plus a read-only K4 lane (the R3-4 inventory below).

### R3-4. Entity batch, stage A (and A2): palette layers and per-instance state

**Flag:** `entityBatch` (`=on` in development; default-on with an `=off` escape after §5 R3/R4).

**What:**
- **Which entities qualify.** At spawn, an entity qualifies if every part resolves to a cache-owned base or paletted material. Excluded: weaponFx, `_entityPlan` VFX, per-entity clones that change blend class.
- **What is built.** One Mesh under the entity root per (side) x (opaque | alpha-test) x page.
  - Its geometry merges the setup's parts after ObjDesc swaps, with per-vertex `(partSlot, surfSlot)`.
  - The geometry is cached per (setup, part-swap signature) and shared across entities, built from the Rust decode-once model cache or in the bake worker.
- **Palette composites as array layers** (L3; OpenAC).
  - The paletted RGBA per `(did, paletteId, subPalettes)` stays exactly as composed today on the CPU and becomes an array layer, so texels are identical.
  - **The layer cache is value-keyed:** keyed by (did, hash of the composed palette), not by the subpalette list. Different subpalette lists that compose to the same colours then share one layer (WebAC's content-hash palette key, `WebAC: models/TextureManager.ts:286`; OpenAC's value-keyed `CompositeTextureKey`, `OpenAC: TextureCache.cs:445-449`). Today paletted materials are cached by value key (`scene3d/materials.js:258`), but each palette signature is still its own material and texture.
  - The shader samples (page, layer), as OpenAC samples (slot, layer) (`OpenAC: Shaders/mesh_modern.frag:59`). Composite admits go through the kit's upload caps.
  - A later GPU palette lookup (R8 index plus a palette row) is **not** in this round: filtering would have to match (L3).
- **Per-instance state rows instead of material clones** (L3; OpenAC binds opacity, flags, selection lighting and the indoor flag as storage-buffer sections, `OpenAC: Wb/WbDrawDispatcher.Rhi.cs:320-357`).
  - Each batched entity gets a state row in the kit's row texture: opacity/fade, luminosity override, selection/highlight, indoor flag.
  - Mutations that keep the blend class and act on the whole entity (whole-object Luminous ramps, hook 8; highlight; indoor lighting flips) write the row instead of calling `_getOrCloneEntityMaterial`, so the entity stays batched.
  - The row is per entity, so it carries no diffuse scale and no per-part values. Diffuse ramps and per-part ramps take the fallback path below (stage A).
  - Mutations that change the blend class (a fade or ethereal that makes opaque parts translucent) still take the sorted fallback path below. Per-instance sorting for translucent parts is not solved by either reference (L3).
- **Per frame:** one combined wasm call per posed entity writes two things:
  - the 7-float pose that `rustRig` already writes into the part Groups (raw quaternion writes, 0.20 ms/frame [M]);
  - the f32 entity-local part matrix row (from `pose_matrices`) plus a `surfSlot → (layer, state)` row into the kit's row texture.

  An entity whose `rigPoseSkip` key is unchanged writes neither (L2). All entities then share one `texSubImage2D`. Keyframe sampling stays in Rust.
- **The part-graph question.**
  - Stage A keeps the part Groups in the graph and keeps posing them, so weapons, particles, nameplates, limbs, decals and film read them exactly as today. Only the per-surface leaf Meshes leave the graph; they move to a side table keyed by part for picking.
  - **Stage A2,** gated on the K4 inventory: consumers switch to an accessor (`getPartWorldMatrix(entity, part)`) that reads the Rust buffer, and then the Groups leave the graph too.
- **Fallbacks to the legacy per-part path,** counted by reason in `__entityBatch.stats()`:
  - translucent and additive parts (they stay per part and sorted: retail's alpha list);
  - weaponFx and item-FX materials (~11 live);
  - an entity that later gets a blend-class-changing mutation (camera fade, ethereal, object translucency, whole-object Transparent ramps, hook 20); texture velocity until it is a state-row field;
  - an entity that gets a whole-object Diffuse ramp (hook 10) or any per-part ramp (Transparent / Luminous / Diffuse part hooks 7 / 9 / 11). `_spawnMaterialRampTween` (`scene3d/entities.js:19473-19482`) drives all of these per material, and per-part ramps cannot fit a per-entity state row. If K4 and S1 show these ramps matter (frequent, or in hitch frames), a later step makes state rows per (entity, part) with a diffuse-scale field;
  - every entity when `?csm=on` (the shadow-caster path, L3 look risk).

  Fallback meshes sample the same array page through a per-mesh layer (the `makeArrayMaterial` pattern), so no 2D copy is kept. If K4 finds a consumer that needs a 2D map, that entity's 2D textures are kept and their bytes counted. A fallback entity's legacy meshes are built once and cached while it lives, so repeated fades do not rebuild.
- `partDegrade`, dismember and `materialRendersNothing` become zeroed part rows.
- **K4** (read-only lane, during R3-3):
  - inventory every consumer of part meshes (picking, limbs, dismember, carnage, film, `particle_attach`, `weapon_fx`, `play_effect_vfx`, `portal_space`) and every per-entity material mutation (`_getOrCloneEntityMaterial` callers, object translucency), split into blend-class-keeping (→ state row) and blend-class-changing (→ fallback). Split the ramp hooks by type (Transparent 20, Luminous 8, Diffuse 10, part hooks 7 / 9 / 11) and count each at Holtburg and in a crowd;
  - count, at Holtburg and in a crowd, the distinct (part geometry, class, page) pairs among visible entities once palettes are layers. This decides R3-9's shape.

  Output: the fallback matrix, the state-row field list and the A2 accessor list.

**Why + evidence:**
- Entity parts are the largest population: 301.1 draws/frame, 168.1 switches [M census].
- Draw cost ≈ 1.39 ms [D].
- The entity scene walk is 0.35-1.0 ms on the 1070 [D, R4 §1.4]; entities are 66% of scene nodes (R2 §1.4).
- `rustRig` posed 1.89M parts with 0 JS fallbacks [M census].
- This is R4 option (d) without its resampling, plus OpenAC's materials-as-data idea expressed in WebGL2 (L3). Neither reference has a GPU-posed, batched creature path (L3: "Neither reference has this").

**Expected 1070 gain** [D]:
- Draws 301 → ~40-90; switches 168 → ~10-15.
- Main thread −1.1…−1.6 ms: draw loop ~−1.0…−1.1, walk −0.15…−0.5 in stage A (leaf meshes only), and up to the full −0.35…−1.0 after A2. Per-part Object3D compose and the per-draw three.js cost go away for opaque parts (L3).
- Fewer fallbacks than the draft design, because blend-class-keeping mutations no longer clone. Measured as the fallback rate in S1.
- CrGpuMain −1.5…−3 ms, unpriced until M1's GL-command census.

**Look risk:** medium, eye-test class. Texels are byte-identical; the lighting, fog and light-clamp chain is unchanged. What can differ:
- draw order inside an entity (coplanar overlays);
- part x root composition in f32 in the shader instead of the per-mesh modelView (~1e-6 relative, sub-pixel);
- per-surface state moving into the layer table (alpha-test ref including the paletted threshold, luminosity, opacity, side split);
- landscape versus cell lighting variants for entities indoors (L3);
- state-row mutations matching what the cloned materials did;
- consumers that address `part_N_surface` meshes.

**Proof:**
- WHAT, in node: layer bytes equal today's per-signature RGBA; two subpalette lists that compose to equal bytes map to one layer, and unequal ones never share; state rows equal `_applyPalettedSurfaceRenderState`; part rows equal the existing `rustRig` parity fixtures.
- HOW: SwiftShader smoke, legacy vs batch, with real setups (human male and female in dyed clothing, a creature, an alpha-tested paletted surface, a luminous surface, a FrontSide part, a highlighted entity). 0 structural difference; ≤ 2/255 on ≤ 0.1% of pixels.
- Consumer matrix test: a raycast hits the same part; dismember and limbs behave as today.
- Laptop boot with 0 errors, fallbacks reported by reason.
- S1: `entityBatch` on/off x3 plus a census delta and the fallback rate in hitch frames.
- rc-eye: chase cam, NPC crowd, equip/dye change, ghost fallback, luminous at night, an NPC indoors. Then the owner eye check.

**Effort:** L (9-11 days). Lanes: merged-geometry builder (Rust or worker), row producer in the `rustRig` bridge, value-keyed layer cache, state rows + mutation routing, side table + accessor, fallback rules. The orchestrator builds wasm once per merge.

### R3-5. Interior batch per landblock: cell shells and props, cell-visibility bits

**Flag:** `interiorBatch`.

**What:**
- **Build:** at EnvCell bake time, append every cell's fused opaque surfaces and its static props into per-(landblock, class, page) batches, with per-vertex `(cellSlot, layer)`. Props are pre-transformed into landblock-local space, as `cellStaticMerge` does per cell. The bake producer and its timing do not change.
  - This is the WebGL2 form of OpenAC's cross-cell merge: OpenAC keeps retail's per-cell visibility but stopped flushing per cell, ~246 ranges → ~47 at Sawato, CPU p50 5.2 → 4.9 ms (commit 9747be79; `OpenAC: Walk/WalkFrameDriver.cs:575-580`) (L5(b)). Under the ANGLE ground rule it is merged geometry, not BatchedMesh ranges.
- **Visibility:** the existing wasm walk (`getRenderSetWithFrustum` ∪ depth-8 `getRenderSetWithPView`, plus `interiorApertureCull` and, until R3-6, the occlusion verdict) writes one bit per resident cell into a small bit texture. This replaces hundreds of `.visible` toggles.
  - There is one bit row per pass (world pass, cells pass), chosen by a uniform, so the indoor split (world pass → Z-wipe → cells pass), the portal stencil, punch and seal passes and `_stampSplitLayers` see exactly today's per-pass cell sets (L5(b) look risk: cells seen through doorways).
- **Unchanged:**
  - Each batch is one three object per (LB, class, page), so LB disposal and `interiorShadowCull` see whole objects.
  - Transparent cell surfaces stay per cell and sorted.
  - Light anchors stay as non-drawn nodes.
  - `interiorWallsFirst` keeps its order.
- This supersedes `cellStaticMerge`, which is deleted after the flip.
- **R3-5b. Shell cache keyed by (EnvironmentId, CellStructure, Surfaces)** (L5(c)). OpenAC shares shell geometry by that triple (`OpenAC: Wb/EnvCellLandblockBuild.cs:135-138, :162-166`). Our wasm builds geometry per cell (`src/geom_bundles.rs:2366-2378`) and no cache keyed on the triple was found. Add one in Rust so repeated dungeon rooms decode and triangulate once. The per-LB batch still holds pre-transformed copies, so the saving is bake time and decode memory, not batch bytes or draws [D]. Graph outputs per cell are unchanged.
- **R3-5c (optional). Lazy interior geometry** (L9). WebAC PERF.3 builds, on landblock load, only the cells in the building portals' stab lists, and the rest when they enter the PVS (`WebAC: world/LandblockObjectStreamer.ts:22-34, :886, :923`); with the 3x3 cut its Holtburg census went cell meshes 665 → 197 (`WebAC docs/performance-budgets.md:172-181`; the drop mixes both changes).
  - **Constraint:** `fetch_env_cells_in_landblock` (`pub async fn` at `src/lib.rs:27299` today; the `:21418` in the 08-13 doc is stale and now falls in the `parse_sky_server_clock_flag` doc comment) is the sole producer of `cell_aabbs`, `cell_membership`, `cell_seen_outside` and the portal graph, and that graph drives the client-local cell entry that ACE trusts on the wire (`docs/2026-08-13-indoor-outdoor-cell-architecture.md` §7). So only triangulation and upload may be deferred. The graph outputs keep today's timing for every cell.
  - Mapping: pre-filter placements to the union of the building portals' stab lists and each portal's `other_cell_id`; enqueue the rest's geometry on PVS demand, prefetched at PVS distance.
  - Retirement (the lesson's third step): when the player leaves the landblock, retire the geometry that was built on demand (its batch slices, pages and rows); the stab-list cells built at load stay. The cell graph is kept in full. Re-entry rebuilds on PVS demand as before.
  - Gate: only if S2's hitch frames or the LB-crossing bake time attribute to EnvCell triangulation. Effect [D]: less bake time and VRAM; draws stay the same at steady state. The lessons doc also expects shorter AABB walks, but with the graph kept complete those do not shrink.

**Why + evidence:**
- From an outdoor orbit, interiors are 358 draws/frame (288.5 + 69.6) with ~80 switches [M census].
- 10-17 GPU timers: cellstatic 1.02-1.29 ms, fused 0.56-0.62 ms [M, include submit time].
- Hiding every interior outdoors gave 26.1 → 29.5 fps [M].
- Interiors total 29k triangles over 669 cells / 808 props (10-17), so collapsing hidden cells in the vertex shader is cheap.
- Retail decides which cells show (PView::DrawCells acclient.c:461450, ConstructView sidedness :462513-462543). The per-cell containers and per-prop meshes are only the CPU-era form. Retail's one-cell-at-a-time shell submission is not taken (L§4; `OpenAC: RetailPViewPassExecutor.cs:146`).

**Expected 1070 gain** [D]: draws 358 → ~30-60; switches 80 → ~8-15; main −0.8…−1.2 ms (draws, projectObject, part of `tickCellVisibility3D`'s 0.26 ms); CrGpuMain −1…−2 ms. Larger indoors and in dungeons, where the cells pass is the whole scene. R3-5b and R3-5c: bake time and memory only.

**Look risk:** medium:
- per-pass cell sets must match exactly (a WHAT property, proven in node);
- draw order between cells changes;
- eviction must free pages and rows.

R3-5b: low (same geometry). R3-5c: low; the risk is pop-in.

**Proof:**
- WHAT, in node: on recorded walks (Holtburg doorways, a sealed dungeon, the indoor/outdoor split transition), the per-pass bitmask equals today's per-pass visible container set every frame; merged vertices equal `cellStaticMerge`'s world-space triangles.
- R3-5b: cached shells byte-equal to per-cell builds on every cell of one dungeon landblock with repeated rooms.
- R3-5c: the cell-graph outputs (AABBs, membership, SeenOutside, portal graph) and their arrival frame are identical with lazy geometry on and off, on the same recorded walks; on a walk that leaves and re-enters a landblock, retirement frees the on-demand geometry's slices, pages and rows, the graph is unchanged, and re-entry rebuilds the same vertices.
- HOW: SwiftShader smoke on one dungeon LB and one town LB with portal punch.
- Laptop town and dungeon boots with 0 errors.
- S2: 3 reps on/off, outdoors and in one dungeon.
- rc-eye: doorways, an interior from inside, the split transition, lanterns at night. Then the owner eye check.

**Effort:** M-L (6-8 days), + S for R3-5b, + M for R3-5c if triggered. It can run in parallel with R3-4 once the kit lands; it touches `cells.js` and `src/geom_bundles.rs`, not `entities.js`.

### R3-6. Retire the occlusion-query proxies (cell half first)

**Flag:** `occlusionCull` (existing). New value `=rigs` (R3-0); later the default flips to off and `=on` stays for one release.

**What:**
- **Cell half, re-check now** (L8). The 10-06 measurement (1,973 → 1,188 draws, 24.5 → 30.5 fps; `scene3d/occlusion_cull.js:11-12`) predates `?interiorApertureCull` (default on since 10-17), which now applies retail's sidedness-and-on-screen rule to interiors. Run an interleaved A/B of proxies for entities and cells (default) vs entities only (`=rigs`), 3 reps per arm plus M1b's A/A: in M1b if the value landed in R3-0 (M1b runs this arm x3, not at its usual 2 reps), else in S2. If `=rigs` is at least as fast on every thread and hitch metric, it becomes the default.
- **Rig half, after batching.** Once R3-4 and R3-5 are default-on, run `occlusionCull=off` against the then-default over the batched build in S2. If off is at least as fast on every thread, flip it.
- `interiorApertureCull` (retail portal sidedness) stays as the coarse interior gate. `rustCull` / `tickFrustumCull` stay for entities and landblocks.
- Delete the proxy code after one release.
- Not taken: OpenAC's building-portal walk as a replacement. It is portal plus frustum, so it still admits doorways hidden behind other buildings, does nothing for rigs, and adds a depth-punch draw per admitted portal (`OpenAC: Walk/WalkBuilding.cs:156-262, :258-259`; L§4). WebAC's per-doorway gate has the same shape (`WebAC: world/buildingCells.ts:260-282`).
- Only if S2's GPU census shows that hidden geometry behind walls matters: a GPU Hi-Z pass (depth pyramid, then one point draw writing per-cell / per-entity bits read by the batches, no readback). Effort M, conditional.

**Why + evidence:**
- 86.5 proxy draws/frame plus ~51 queries/frame [M].
- Verdicts arrive 1-2 frames late, with flip damping up to 24 frames (`occlusion_cull.js:61-69`).
- The proxies exist only to save per-object CPU submission (`occlusion_cull.js:1-44`).
- Neither reference client uses occlusion queries (L8).
- With reversed-Z, early-Z is back, so hidden batch geometry costs only rejected fragments. Retiring the rig proxies before R3-4 would let hidden NPC part draws back in.

**Expected 1070 gain** [D]: cell half, the cell proxies' share of the 86.5 proxy draws and ~51 queries per frame, minus any interior draws that come back (upper bound 86 draws, L8); full retirement −86 draws, −172 query commands, −0.3…−0.4 ms main. GPU may rise by +0…0.5 ms; it is priced, not assumed.

**Look risk:** none for opaque pixels: removing a cull can only add draws. The late-reveal pops go away.

**Proof:** node test for `=rigs`; arms x3 with GPU ms not worse beyond noise at 1080p; rc-eye Holtburg orbit and street.

**Effort:** S.

### R3-7. GPU particles: retail `Particle::Update` evaluated in the vertex shader

**Flag:** `gpuParticles` (supersedes `rustParticles`).

**What:**
- **R3-7a, motion in the shader** (L7, which goes one step further than both references).
  - The CPU only emits and kills. Each new particle writes one ring-buffer spawn record: origin, offset, a/b/c, spawn time, lifetime, ParticleType, scale and translucency lerp ends, seed, parent (start frame, or an emitter / part slot).
  - Per frame, one row per live emitter or parent frame. Rig-attached emitters read R3-4's part rows.
  - The vertex shader evaluates the closed forms at `uTime` (acclient.c:330313; `UpdateParticles` :331097) plus the scale and alpha lerps. Dead particles collapse. OpenAC's C# simulation uses the same closed form in particle age (`OpenAC: AcDream.Core/Vfx/ParticleSystem.cs:1100-1112`).
  - Unchanged in R3-7a: buckets, blend modes, in-bucket order, unfogged additive, and the ParticlesOverClouds / FxGlow routing.
- **R3-7b, fewer buckets** (L7), after a census of live buckets at Holtburg (R3-0 owner rows):
  - put sprite textures in size-bucketed array pages (the kit) with a per-instance layer;
  - key buckets on (blend, render layer, sky) instead of today's `gfx|layer|a|sky` (`scene3d/particles/particle_manager.js:3187`). OpenAC's billboard batch key is only "additive or not", with the texture per instance (`OpenAC: ParticleRenderer.cs:20, :35`);
  - sort back to front within each merged bucket (OpenAC sorts globally, `OpenAC: ParticleSubmissionOrdering.cs:59-62`).
- Not taken: OpenAC's immediate alpha path, one particle per draw (`OpenAC: ParticleRenderer.Rhi.cs:300-312`); WebAC's one InstancedMesh per emitter with cloned geometry and material (`WebAC: effects/ParticleSystem.ts:401-423`).
- Afterwards, delete the `rustParticles` bridge (`scene3d/rust/particles.js`) and its wasm exports (`src/scene_wasm/particles.rs`). The kernel in `src/particles/` stays as the cargo-tested CPU oracle for the shader readback (L7: "The shader motion must be parity-tested against the Rust kernel") until the JS parity generators cover the same fixtures.

**Why + evidence:**
- JS path 1.05 ms [M 10-23], or 1.23-1.40 ms [M 3-pair profile]; `rustParticles` 2.34-2.54 ms, its excess all in the bridge marshalling and wasm (§1.2).
- Census: 127 emitters, 334 live particles, ~17-20 draws.
- Retail's per-particle update is closed-form in lifetime and parent frame, so per-frame CPU work drops to O(emissions + emitters).
- Precedents: grass, animated scenery.

**Expected 1070 gain:** R3-7a −0.8…−1.0 ms main vs the JS path [D]; more at Linvak Tukal (14,268 anchors, `statics.js:5241`) and in combat FX. CrGpuMain falls with the instance-buffer re-uploads. R3-7b: particle draws drop to a few per blend class [D]; its size depends on the bucket census (L7).

**Look risk:**
- R3-7a: low-medium. GPU f32 vs CPU f64 drift is sub-mm over a particle's life. Emission order and RNG are unchanged.
- R3-7b: medium. Sort order across GfxObjs changes when buckets merge (L7). Eye-test class.

**Proof:**
- WHAT: the existing particle parity generators and the Rust kernel pin the CPU reference per ParticleType.
- HOW: SwiftShader readback of positions into an RGBA32F target within 1e-4 relative, every ParticleType including persistent and parented ones; rc-eye fountains, braziers, spell FX, Linvak.
- R3-7b: rc-eye of overlapping emitters with different sprites (a brazier in front of a portal swirl), before and after.
- S2 arm x3 for each of R3-7a and R3-7b, plus the Linvak spot.

**Effort:** M (4-5 days) for R3-7a, + S (1-2 days) for R3-7b.

### R3-8. Checkpoint M2 and re-route

**What:**
- Repeat M1's anatomy (ultra and high, 1080p, 3 reps) and the structure-ceiling probe on the new baseline. Write ledger v2.
- Apply rule R5:
  - main thread still over budget → R3-9 / R3-10;
  - CrGpuMain over budget → R3-11 HUD items and R3-10;
  - GPU over budget → R3-11 fill items and the governor.
- Fold in the M1c WebAC readings (§4.1) [D]:
  - if WebAC on the 1070 is about as fast as our H-retailscope arm, the remaining gap is three.js submission plus ANGLE on this machine, and fewer real draws (R3-4, R3-5, R3-7, R3-9) stays first;
  - if WebAC is clearly faster, the extra cost is in our passes, shading and bookkeeping, and R3-11's pass work (render walks, governor) moves ahead of R3-9.
- Repeat the upstream arm if available, and the WebAC arm.

**Why:** after R3-2 to R3-7 the binding thread is expected to change. Stage 1 spent ~17k lines for ~3 ms because nobody checked which thread bound.

**Effort:** S + 1 session.

### R3-9. Entity stage B: one arena or instanced runs per class (gated)

**Flag:** `entityArena`.

**What:**
- Only if M2 shows entity draws still at ≥ ~100 per frame in crowd scenes (Linvak, combat).
- Shape, chosen from K4's count of distinct (part geometry, class, page) pairs in view:
  - **many entities per pair:** one instanced run per (part geometry, class, page), with per-instance (pose row, part index, layer, state row) attributes (L3 mapping steps 2-4; OpenAC's flat path shows a key with no entity field collapses identical parts, `OpenAC: Wb/GroupKey.cs:7-17`);
  - **few entities per pair:** one dynamic arena per (class, page) holding every batched entity's merged geometry, with preallocated capacity and a free list; per entity a camera-relative root row plus a visible bit.
- Either way, one draw per run or per (class, page). The existing gates (tick distance, `?rigCellGate`, occlusion) apply by compacting the instance list on the CPU each frame, O(visible rigs) (L3 step 5).
- Equip and dye changes re-slot the entity off-thread.

**Why:** stage A leaves one continuation per (entity, class, page), which grows linearly with crowd size.

**Expected gain:** Holtburg −0.1…−0.3 ms; crowds −0.5…−1 ms main [D].

**Look risk:** medium. Culling moves into bits or compaction; precision depends on the camera-relative rows.

**Proof:** as R3-4, plus a crowd arm.

**Effort:** M.

### R3-10. Static world: measure, then decide (no build this round without the gate)

**What:** arms only, inside M1 / M2:
- (a) `batchedRuns=off`: P0 arm 2, the per-range CrGpuMain price of ANGLE's multi-draw emulation. Laptop 10-23: ~1,523 ranges asked, 267 issued.
- (b) the `statArrayMerge` re-arm.
- (c) the `objRadius` arms from M1 (static pool instance counts, triangles and bake churn scale with ring area: 9, 25 or 81 landblocks; per-frame CPU scales less, because opaque pools do no per-instance work on unchanged frames; L4).

Only if one of them moves CrGpuMain or renderCPU beyond noise: in round 4, fold chunk buckets, pools, atlas, buildings and singletons into kit class pools over native-size pages, with instanced runs or vertex pulling (one `drawArrays` per bucket). Spatial buckets stay: ring-wide merging lost node culling, 22.5 vs 29 fps [M wall row 114].

Round-4 note (L§4): our statics still run THREE.LOD in JS (`scene3d/statics.js:2066, :2281`). The GPU form exists in neither reference: draw each LOD level's instanced mesh and let the vertex shader collapse instances outside that level's distance band [D].

Not taken (L§4):
- WebAC's region-wide no-cull InstancedMesh pool as a replacement for our sector pools. Our opaque pools already skip per-instance culling (`scene3d/pool_registry.js:579-583`); the swap brings no measured gain and loses spatial culling per pool.
- OpenAC's per-frame re-staging of every visible static instance (`OpenAC: Wb/WbDrawDispatcher.Rhi.cs:294-360`). Our JS version of a per-frame walk across the whole ring was closed as a regression, 22.5 vs ~29 fps moving (`scene3d/static_batch_x.js:4-8`).
- More multidraw ranges as a way to cut draws (§0 rule 5).

**Why:** the static world is already the most batched population, and its wall says "a new mechanism, or nothing".

**Effort:** XS this round.

### R3-11. GPU-fill, post and pass levers; per-pass budget governor (gated on the binding thread)

**Flags:** `cloudResScale` (existing), `bloomGlowPyramid` (new), `hudCanvas` (new), `projectOnce` (new), `gpuGovernor` (new). Each new one is built default off and flips only after its 1070 arm (§4 M2/M3) wins under §5 R3.

**What,** in the order M1/M2 prices them:
1. HUD orbs and radar drawn into the WebGL canvas from DAT sprites, if `hud=none` priced ≥ ~2 ms of CrGpuMain after the R3-2 diet.
2. `cloudResScale=0.5` at high, then ultra only with the owner's OK. Later, one 2D cloud-shadow map refreshed a few times a second instead of 3 cascades.
3. One blur pyramid for bloom and fxGlow, and the late NaN scrub folded into the final pass.
4. **`?projectOnce` (new): project once for several passes** (L6, step 2), only if R3-0's walk count shows several full walks per frame over layer subsets of the same scene: project once and feed pre-built render lists to those passes. three.js has no stock API for this; it needs a custom render-list path [D]. Effect up to ~1-2 ms main per avoided full walk [D].
5. **`?gpuGovernor`: per-pass GPU budgets with hysteresis** (L11), built on R3-0's whole-pass timer queries.
   - OpenAC gives every shadow preset GPU p50/p99 budgets (Low 2.0/3.0 ms, Medium 3.25/4.5 ms, High 4.5/6.0 ms; `OpenAC: DirectionalShadowQuality.cs:94-136`). Its governor downgrades after 180 frames over budget, upgrades after 900 frames of headroom, then cools down for 300 frames (`OpenAC: Packs/AtmosphericAutoQualityController.cs:39-41`).
   - Ours today, `scene3d/adaptive_render_scale.js`, is closed-loop on resolution only.
   - **Resolution stays with `adaptive_render_scale.js`.** The lessons list resolution as a governor knob; we do not take that. The governor never turns resolution, so the two loops never act on the same knob. Its arms run with `adaptiveRes=off`, so one closed loop is measured at a time; whether both may run together at ultra is part of decision (h).
   - Every bench arm pins `gpuGovernor=off` (§4 protocol, R3-0 hbbench asserts) unless the arm is the governor arm, so no other verdict is measured under a closed quality loop.
   - Per-pass budgets come from ledger v0/v2. The knobs are only those the owner lists under decision (h), for example cloud resolution and quality, SSAO, haze. CSM is already off on every tier.
   - It holds a frame-time target instead of sitting at today's fps; it does not make any given look cheaper.

Round 4 candidates: a near-field terrain runtime virtual texture (12-20 taps → ~2-3), an R11G11B10F world target, and the sky drawn last from a sky-view lookup texture.

**Why + evidence:**
- HUD raster 3.1-3.4 ms per present [M].
- Clouds + AP ~3.7-4.3 ms GPU [D].
- Final pass + bloom + glow ≈ 26.6 draws [M].
- projectObject + matrices + sort = 3.18 ms/frame summed over all walks, mean of profile pairs 2-3 [M] (3.29 in caveated pair 1).
- Once R3-4 to R3-7 land, the main thread should approach CrGpuMain and GPU time.

**Expected gain:** HUD ~−3 ms CrGpuMain; clouds −1…−2 ms GPU; post −10…−14 draws, −0.15…−0.3 ms main; project-once up to ~1-2 ms main per avoided walk [D]. The governor: no fixed gain; fewer frames over the target.

**Look risk:** HUD medium; clouds and post eye-test class (owner-signed looks); project-once none if the lists are equivalent; the governor by design (the owner picks the knobs).

**Proof:** per-pass GPU ms from the anatomy pass at 1080p, A vs B; rc-eye at dawn, noon, dusk, night and storm; owner eye test.
- `projectOnce`: a node test that the pre-built render lists equal three's per-pass lists (same items, same order, same per-pass layer filtering) on recorded frames; then on/off x3 in M2 or M3 (§4).
- Governor: a node test of its state machine (180 / 900 / 300-frame thresholds) and that it never writes the render scale; then the §4 governor arm (M2 or M3) that holds the target on the Linvak spot.

**Effort:** M-L, + S for the governor.

### R3-12. WebGPU gate (conditional)

**What:**
- M1 already ran the WebGPU capability probe.
- Build the standalone W8 spike (`tools/webgpu_spike/`) only if draws are ≤ ~300 per frame and CrGpuMain still binds. It is fed by a dump of the R3-3 rows and pages and draws the opaque world along the bench path five ways:
  - (a) the WebGL2 kit;
  - (b) raw WebGPU compute cull + one `drawIndirect` per class, vertex-pulled from storage buffers;
  - (c) (b) inside a render bundle;
  - (d) (b) + two-phase Hi-Z;
  - (e) three r184 WebGPURenderer with BundleGroup.
- **Go criterion** (3 reps, idle box, equal pixels): (b), (c) or (d) beats (a) by ≥ 2 ms per frame of main + GPU-process time combined, or by ≥ 1.5 ms GPU. If (e) is more than 0.5 ms worse than (c), a port would need a purpose-built executor rather than three's object path.
- A go also needs the owner to amend charter N4 ("No WebGPU port", `docs/reengineering/pass-01-requirements-charter.md:234`).

**Why:**
- three r184's WebGPU path draws BatchedMesh as a JS loop of `drawIndexed` (`WebGPUBackend.js:1600-1627`).
- It has no multi-draw-indirect; Chrome keeps that behind the unsafe flag.
- It creates pipelines synchronously in the render path (`WebGPUPipelineUtils.js:275-297`).
- External reports put its per-draw CPU cost at ~2-4x WebGLRenderer's.
- The port surface is 33 ShaderMaterials, 106 `onBeforeCompile` references, 21 pmndrs passes, and takram clouds, which have no WebGPU path.
- The kit's std430 rows carry over unchanged, so the decision can wait until it is cheap to measure.
- No reference helps here. OpenAC's cheap draws come from Vulkan 1.3 multi-draw-indirect with bindless textures (a draw is a 20-byte command), and its indirect commands are still built on the CPU; no client in the comparison culls or generates commands on the GPU (L§1, L§2). Truly GPU-generated draws would need WebGPU, which the lessons doc did not evaluate (L§3).

**Effort:** S (gate), + M for the spike if triggered.

---

## 4. Measurements owed on the 1070

**Protocol for every session:**
- off-screen, no audio, never touch the user's Chrome (match only by `--user-data-dir`), one real-world tab at a time;
- fresh `--user-data-dir` per arm-rep;
- interleaved, rotated order;
- the 65 s login cool-down;
- release wasm;
- `skytime=13` plus a clear DayGroup;
- `adaptiveRes=off`, `targetFps=0`, `renderScale=1`, and `gpuGovernor=off` once that flag exists (R3-11), except in the governor arm;
- 1920x1080 unless the arm says 720p;
- background CPU sampled with boxwatch (R3-0).

Run without the gate override whenever possible, so `hbgate.ps1`'s idle rule applies. Each arm-rep is ~5 min fps + ~3 min anatomy [D].

| Session | When | Arms | Purpose |
|---|---|---|---|
| **M1a** | before any build lands | A = B0 ultra, A′ = B0 ultra (A/A), L0 = `nullRender=1`, H0 = `hud=none`, Q-low, Q-mid, Q-high, A at 720p; 3 reps each; anatomy (whole-pass timers, heading bins, owner census, ranges, walks per pass) on A, H0, Q-high; in-session sweeps (`renderScale` 1/0.5/0.25, cloud res/quality, haze, shafts, SSAO) at the orbit and a street pose; structure-ceiling probe V0-V3 x3; layer-mip readback probe; WebGPU capability probe | Which thread binds per tier; floors; HUD price; per-draw calibration on both CPU threads |
| **M1b** | before | ultra, 2 reps + A/A: `clouds=off`, `cloudResScale=0.5`, `msaa=0`, `ssao=off`, `bloom=off&fxGlow=off`, `layerHaze=off`, `lightShafts=off`, `terrainGrass=off`, `pom=off`; structure arms `occlusionCull=off`, `occlusionCull=rigs` (if built; 3 reps, because R3-6 flips its default from this arm), `cellStaticMerge=on`, `statArrayMerge=on`, `batchedRuns=off`, `partDegrade=on`, `freezeWorldRoots=on`, `rustEntityWorld=on` (gate `__entityWorld.stats().projections === 1`); `objRadius=1` and `objRadius=2` vs default 4, each at Holtburg and at a hilltop; spots: Linvak Tukal ultra (also `partDegrade=on` there), Holtburg hour 22 | Feature prices (ledger v0); settles the six owed built arms; prices ANGLE ranges, the cell half of the proxies, and the object ring |
| **M1c** (WebAC A/B, §4.1) | in an M1 window after M1a, not blocking | H-default, H-retailscope, W at the same parked pose; 3 reps each, interleaved; W's profile, window, sky and panel pins and exceptions per §4.1 | The same-stack stand-in for the missing upstream A/B: a stock-three.js µs-per-draw on the 1070 and which half of our frame to attack |
| **M1d** (OpenAC, optional, §4.2) | only after decision (i) | O-retail, O-atmo at the same pose | Native ceiling: real GPU work vs ANGLE overhead; a native retail-shaped CPU walk |
| **M1e** (upstream A/B) | when available, not blocking | the upstream holtburger renderer at the same pose and resolution against the laptop ACE: fps, draws/frame, CrGpuMain, GPU ms | Prices our additions against a simple modern renderer, as the owner asked. The 100-500 fps claim cannot be broken down without it. |
| **S1** | ~end of week 3 | `animSceneryBatch` on/off x3; `entityBatch` on/off x3 + census delta + fallback rate; `rigPoseSkip` on/off x3; `skipEmptyPasses` on/off x3; `uploadWarmDraw` on/off x3 scored on first-turn max and h100; each R3-2 worker-wait fix on/off x3 (same hitch metrics); row-upload, layer-admit and kit-geometry upload timings against the upload caps; async-link count, program-key diff and first-turn hitch | Kit costs on the real driver; entity stage A verdict (rule R6 stop check) |
| **S2** | ~week 6 | `interiorBatch` on/off x3 (town + dungeon); `occlusionCull` arms over the batched build x3 with GPU ms; `gpuParticles` on/off x3 + Linvak (R3-7a, then R3-7b); eye-test batch | Interior, proxy and particle verdicts |
| **M2** | after S2 | M1a repeated; probe repeated; M1c repeated; upstream arm if available; `projectOnce` on/off x3 and the `gpuGovernor` arm (ultra, Linvak Tukal spot, on vs off x3, `adaptiveRes=off`) if they landed before M2 | Ledger v2, re-route (R3-8) |
| **M3** | end of round | all four tiers at 1080p and 720p; lock tier presets; WebGPU gate check; `projectOnce` on/off x3 and the `gpuGovernor` Linvak arm x3 if not run in M2 | Ledger v3, before/after vs B0, WebAC and upstream |

The M1a + M1b arm count is ~6-9 h of 1070 time [D] (the draft's ~4-7 h plus ~9 new arm-spots x 2 reps). M1c adds ~1-1.5 h plus WebAC's first-load DAT streaming [D]. Split it across three windows when the 1070's user is away, for example overnight.

### 4.1 M1c: WebAC on the 1070, the same-stack stand-in for the upstream renderer

**Why:** the upstream holtburger Electron renderer is not available (§1.6). WebAC is the closest substitute we can run: three.js ^0.186.1 `WebGLRenderer` on WebGL2, every system on the main thread, one Mesh per creature part-surface (L§1). It reaches about 800 draws at Holtburg by drawing less (the retail 3x3 object ring, one `renderer.render()` per frame, no composer, shadows or post, per-vertex retail lighting), not by submitting better. Its published numbers are from an Apple M3 Max (76.8 / 67.1 / 70.7 fps idle / turning / running; 806 / 950 / 788 draws; renderJs p50 6.5 ms; `WebAC docs/performance-budgets.md:136`). It has never run on a 1070-class GPU. It runs today with no build and two harness-side workarounds (L§5.1).

**Steps** (L§5.1; exact commands and the iteration shim are there):
1. **Laptop:** check `free -m` first (≥ 2.5 GB available) and run nothing heavy at the same time. `npm install` in `/mnt/wbterminal1/ac-refs/webac` (`--ignore-scripts` if better-sqlite3 fails to build). Symlink the three base DATs into `dat/` (no `client_highres.dat`, so Very High texture detail draws at High).
2. **Bridge:** our `holtburger-wsbridge` cannot carry WebAC's bare AC datagrams (it requires a JSON hello and port-prefixed frames: `apps/holtburger-wsbridge/src/handshake.rs:3-11`, `crates/holtburger-transport-ws/src/frame.rs:19-37`). Run WebAC's own bridge on :9090 to ACE :9000 (`services/ws-tcp-bridge/src/bridge.ts`), with setsid nohup and logs on `/mnt/wbterminal2`. It coexists with ours on :8080.
3. **Dev server:** `npx vite --host 127.0.0.1 --port 3000 --strictPort`. URL login, `?bridge=`, `window.__ac` and `acDebug` exist only in dev; WebAC's own numbers were taken in dev too.
4. **Tunnel:** add `-R 3000:127.0.0.1:3000 -R 9090:127.0.0.1:9090` to the box ssh, keeping `-L 9333`, `-R 8765` and `-R 8080`.
5. **Box:** the existing off-screen test Chrome (`--mute-audio`, `--user-data-dir C:\Temp\cdpwb-wls`, CDP :9333), one tab via playwright-core `connectOverCDP`. This persistent profile is a protocol exception (see "Protocol exceptions and pins" below). Before navigating, `addInitScript` the DAT-iteration shim (portal 2074 / cell 982 / language 994). ACE terminates clients that report older iterations (`ACE.Server/Network/Handlers/DDDHandler.cs:165-168`), the base DATs report portal 2072, and WebAC cannot read the zlib r10 DATs.
6. Navigate to `http://127.0.0.1:3000/?ace&bridge=ws://127.0.0.1:9090&account=<ACCT>&password=<PW>&degmul=1`. The first load streams ~1.27 GB of DATs into OPFS; never add `?nocache`. Confirm UNMASKED_RENDERER reports GTX 1070 / D3D11.
7. **Park:** gate on `acDebug.collisionState().x > 0` and `window.__ac.sceneManager`; then `acDebug.admin('@teleloc 0xA9B40001 96 96 80')` and `acDebug.setPlayerYaw(0)`; wait until the scene mesh count is stable to ~1% across 4 polls.
8. **Measure:** from the laptop, `AC_URL='<same url>' npx tsx tools/measure-perf.ts --attach http://127.0.0.1:9333 --no-reset --secs 20`. Output goes to `verification/perf/perf-<utc>.json` in the WebAC repo (`/mnt/wbterminal1/ac-refs/webac/verification/perf/`; `tools/measure-perf.ts:100, :758`). Quote only the idle phase as the same-spot number. Record draw distance (default 8) and degmul.
9. **Copy the result** into `$RC/m1c/` (for example `W-r<n>.json`) beside our H arms' run JSON, so `hbreport.py` reads both sides, before cleanup.
10. **Clean up:** close the tab, stop vite and the bridge, drop the two extra forwards. Never kill the box Chrome except by matching its user-data-dir.

**Protocol exceptions and pins** (the §4 protocol applies otherwise):
- **Profile.** W reuses the persistent `C:\Temp\cdpwb-wls` profile instead of a fresh `--user-data-dir` per arm-rep, because it holds WebAC's ~1.27 GB OPFS DAT cache (a fresh profile would re-stream it every rep). It also holds a warm shader cache, so W runs warm against our fresh-profile H arms. Record this in the run JSON. The asymmetry favours W on load and compile hitches, so first-turn max and h100 are not compared across W and H.
- **Window size.** Pin the same window size for W and both H arms: 1920x1080 (the §4 default), set before navigating. Record `innerWidth` x `innerHeight` and `devicePixelRatio` in every arm.
- **Sky.** WebAC has no sky-time URL override (none found in `config/urlOverrides.ts` or `utils/debugTools.ts`), so W follows ACE's clock. Record ACE's in-game hour at each W rep and run the H arms at the matching `skytime` instead of `skytime=13`. If the hour cannot be matched, note the mismatch next to the reading.
- **Panel.** All arms on the same 120 Hz panel, vsync state recorded (L§5.3).

**Arms** (all at 0xA9B40001 (96, 96, 80), yaw 0, parked, on the same 120 Hz panel, same window size, vsync state and `devicePixelRatio` recorded; L§5.3):

| Arm | Client and settings |
|---|---|
| **H-default** | Ours, B0 ultra. |
| **H-retailscope** | Ours with `objRadius=1&clouds=off&ssao=off&bloom=off&fxGlow=off&layerHaze=off&lightShafts=off&terrainGrass=off&pom=off`: the closest flag match to WebAC's job. There is no `msaa=0`: our default MSAA stays on, because WebAC also renders with MSAA. Lighting still differs (WebAC is a per-vertex D3D8 port), WebAC's terrain reaches draw distance 8 (17x17 blocks) against our 11x11 ring, and MSAA and DPR differ: WebAC uses default-framebuffer MSAA at uncapped device pixel ratio (`new THREE.WebGLRenderer({ canvas, antialias: true, ... })` + `setPixelRatio(window.devicePixelRatio)`, `WebAC: scene/SceneManager.ts:163-166`; L§2 frame-passes row, L§4), while ours runs its own default MSAA at `renderScale=1`. The recorded `devicePixelRatio` shows how far apart the pixel counts are. |
| **W** | WebAC, draw distance 8, `degmul=1`. |

**Metrics:** heading-binned draws (plus multidraw ranges for ours), renderJs (ours through the R3-0 wrapper), main-thread busy, GPU ms (timer query for ours), fps.

**What it tells us** [D]:
- **W vs H-retailscope** (same stack, similar scope): if W's fps is about the same, the remaining gap to 60 fps is three.js submission plus ANGLE on this machine, and fewer real draws (R3-4, R3-5, R3-7) is the main lever. If W is clearly faster, the extra cost is in our passes, shading and bookkeeping, and the pass items (R3-2 empty-pass skip, R3-11 items 4-5) come first. R3-8 applies this.
- **W's renderJs p50 ÷ its draws** gives a stock-three.js µs-per-draw figure for the 1070, taken with the same wrapper as ours.
- **H-default vs H-retailscope** prices our scope (object ring plus composer extras) on our own stack.
- **Not a target:** WebAC renders Gouraud lighting with no post-processing.

**Blockers and caveats:**
- **Account.** ACE boots an account already in world. Use a second Developer-level account (needed for `@teleloc`) or run the clients one after the other. Credentials go only in the URL or environment at run time, never in docs.
- **Box memory and disk.** The whole-DAT path keeps ~1.3 GB of ArrayBuffers in the tab and writes ~1.27 GB to OPFS on the box disk. Never run it alongside one of our real-world tabs.
- **Content.** The base DATs are the same source holtburger bakes from; the ACE world itself is the r10 set.
- **Off-screen rAF.** Never minimize the window; hidden tabs throttle rAF.
- **Parking.** WebAC's own helper uses `@telepoi holtburg`, a different cell of the same landblock, hence `--no-reset` and our own `@teleloc`.

### 4.2 M1d: OpenAC native A/B (optional, heavy)

**Why:** OpenAC bounds what a retail-shaped CPU walk costs in native code, and how much of our ~14-15 ms GPU process per present is real GPU work. Its draws are cheap because of Vulkan 1.3 MDI with bindless textures, not a design WebGL2 can copy (L§1). Its only published numbers are from an unnamed machine: Sawato / Arwic / Northwatch CPU p50 5.04 / 5.21 / 0.53 ms, GPU p50 2.37 / 1.93 / 0.15 ms (commit 662ca87a).

**Steps** (L§5.2):
1. **Build** the win-x64 app and bake tools. `global.json` pins SDK 10.0.300; the laptop has only 8.0.420 and 10.0.203, so install a 10.0.3xx SDK on `/mnt/wbterminal1` with `NUGET_PACKAGES` there too (system disk ~87% full). Self-contained ReadyToRun publish of `src/AcDream.App/AcDream.App.csproj` and `src/AcDream.Bake/AcDream.Bake.csproj`. **This is a heavy job on the laptop:** one at a time, `free -m` ≥ 2.5 GB, under `capped-build`. Building on the 1070 instead loads a machine a person is using.
2. **Data:** the base DATs do not work (no highres, iteration 2072). Use ACE's r10 set (portal, cell, local from `/home/wbterminal/ace-dats-ssd/ace-r10-dats`; highres from `/mnt/wbterminal2/dat-patch-r10/ace-r10-dats`), ~2.25 GB, copied with `rsync -aL`. Bake once over plain ssh to a ~570 MiB `acdream.pak`.
3. **Capability check:** one run with `ACDREAM_VULKAN_PROBE=1`, `ACDREAM_NO_AUDIO=1`, `ACDREAM_AUTOMATION_EXACT_FRAMEBUFFER=1`.
4. **Session config** JSON (schema `AcDream.App/Headless/Configuration/HeadlessConfiguration.cs:40-55`): the laptop ACE endpoint, the account, character 0, the password from an environment-variable provider, `loginCommands: ["@teleloc 0xA9B40001 96 96 80"]`, a `statusFile`.
5. **Launch .bat** with `ACDREAM_NO_AUDIO=1` (mandatory: no sound may reach the 1070's user), `ACDREAM_FRAME_PROF=1`, `ACDREAM_GPU_STAGE_PROF=1`, `ACDREAM_FRAME_HISTORY=<csv>`, `ACDREAM_AUTOMATION_EXACT_FRAMEBUFFER=1`, scratch `ACDREAM_CONFIG_DIR` / `ACDREAM_DATA_DIR`; optionally `ACDREAM_UNCAPPED_RENDER=1` for throughput only.
6. **Run hidden** in the interactive session with `schtasks /create ... /it` plus the runbook's `hidden-run.vbs` (from plain ssh a GUI process lands in session 0).
7. **Read:** wait for `status.jsonl` to show the character in world and the teleloc applied; read the rolling `[frame-prof]` lines (cpu_ms p50/p95/p99, gpu_ms p50/p95, per-stage update/upload/render/present; `AcDream.App/Diagnostics/FrameProfiler.cs:205-224`) and the `[gpu-stage]` lines (shadow, world, volumetric, post only).
8. **Stop** by PID or image path, delete the scheduled task. Never touch the box Chrome.

**Arms:** O-retail (retail pack, no shadows or post, High preset: Near 4 / Far 12) and O-atmo (atmospheric pack, shadows on), at the M1c pose.

**Blockers and caveats:**
- SDK band and the heavy publish (step 1).
- **Off-screen presenting is unverified.** The only hide mechanism is the never-shown window (`GameWindow.cs:63, :72`). If the frame-prof frame count stops advancing, the window is not presenting. Fallbacks: an owner-present session, or a one-line local window-position patch.
- **Firewall prompt.** A new exe's first UDP bind may raise a Windows Defender Firewall prompt on the person's desktop. Pre-add an allow rule for `AcDream.App.exe` over ssh before the first run.
- **Content mismatch.** r10 draws 4x-subdivided creature parts, more geometry than our base-DAT bake, so the comparison is conservative against OpenAC.
- The frame-history CSV is written only on a clean Dispose; rely on the stdout lines.
- Same account conflict as WebAC.

**What it tells us** [D]: O-retail GPU ms against our ~14-15 ms GPU process per present bounds the split between real GPU work, ANGLE/CrGpuMain per-draw overhead and our shading. OpenAC's CPU p50 bounds a native retail-shaped walk. Neither is a target.

---

## 5. Decision rules (written into each queue file before the run)

| Rule | Text |
|---|---|
| **V (validity)** | An arm-rep is INVALID, re-queued and never averaged, if any of these hold: `idle` < 60 s in any boxwatch sample; `gpu3d_other` > 5%; any non-test process using ≥ 1 CPU core-equivalent in any sample [D threshold; the bench-1 Seagate Toolkit case]; entity count differs from arm A by > 10% (R3-0 server-state pin) [D threshold]; console errors > 0; dev wasm; wrong adapter. If two scheduled windows yield no valid reps for an arm, accept 5 reps with a reported A/A noise in place of the idle gate, and mark the result "noisy box". |
| **R1 (noise)** | noise = max(\|A − A′\|, half of A's rep spread). A delta is real only if it exceeds max(2 x noise, 3% fps or 0.5 ms). |
| **R2 (scoring)** | Score on the binding thread's ms (main busy per frame, CrGpuMain WEBGL per present, GPU ms), plus still / moving / tour fps, p50 / p95, h100 / h250 / max / jank. Never on draw counts alone; draw counts are heading-binned and reported with multidraw ranges. |
| **R3 (keep)** | A perf change goes or stays default-on only if all five hold: (i) its binding-thread ms moved by ≥ 50% of the prediction; (ii) at least one of still / moving / tour fps improved by a real delta, and no segment regressed by one; (iii) hitch metrics not worse by a real delta; (iv) 0 console errors; (v) the look gate (R4) passed. Otherwise it goes off and keeps its code only if a later step needs it. INCONCLUSIVE gets 3 more reps once, then goes off. |
| **R4 (look)** | WHAT kernels: bit-exact, or ≤ 1 f32 ulp, in node or cargo; array layers byte-equal on the 1070 readback. HOW changes: rc-eye stills at 1080p with `skytime=13`, compared by `rc_eye_diff.py`, with particles and sway masked. Default threshold: ≤ 1% of pixels over 8/255 and ≤ 0.1% over 32/255; each step may set a tighter one. Every heatmap gets a structural review. Then the batched owner eye test; the owner can veto. |
| **R5 (routing)** | The binding thread is the largest of main busy per frame, CrGpuMain per present, and GPU ms, at the tier's resolution. If GPU ms ≥ 0.9 x frame time, GPU levers go first. If CrGpuMain ≥ main, GL-command levers go first (batching, HUD raster). Otherwise main-thread levers. Never claim fps for a lever on a thread that is not binding; book its ms as headroom. |
| **R6 (stop)** | A structural lane that delivers < 50% of its predicted ms at stage A stops before stage B and gets a written post-mortem. |
| **R7 (tier presets)** | A tier preset change ships only if it moves the over-budget thread under its ceiling, or is look-neutral and cheaper. Ultra looks change only with explicit owner OK. This includes `objRadius` and any governor knob. |
| **R8 (probe gate)** | If the M1 structure-ceiling probe's V1/V2 do not cut main-thread world-render ms and CrGpuMain WEBGL ms by ≥ 40% against V0 on the 1070, R3-4 and R3-5 are re-scoped before any L-sized build: smaller stage A, or GPU-side levers first under R5. |
| **R9 (WebGPU)** | Go only on the R3-12 criteria plus the owner's charter amendment. |
| **R10 (reference clients)** | WebAC, OpenAC and upstream numbers are bounds that say which half of the frame to attack. They are never targets, never a pass/fail gate for a step, and never mixed into B0 comparisons. A reference reading on a different machine or content is quoted with that machine and content. |

---

## 6. Risks

| Risk | Where | Mitigation |
|---|---|---|
| No idle windows on the 1070 (a person uses it daily; v2 idle 0-22 s) | every session | Schedule with the owner for away hours; rule V fallback (5 reps + A/A); keep arm lists tight. |
| Background load on the box goes unseen (bench 1: a CPU core held at 100% by Seagate Toolkit; one-arm swing 27-41 fps) | every session | boxwatch samples top CPU processes (R3-0); rule V CPU check; hbreport marks contaminated runs. |
| Draws removed x µs per draw does not predict ms (walls 29/107/137; R3 assumed 0.6 µs, lane X measured 2.4-3.7; other figures on file 10 and 25 µs) | R3-4, R3-5, R3-10 | Dated 1070 calibration (R3-0); structure-ceiling probe and rule R8 before L work; rule R6 stop at stage A. |
| Array-layer mips or filtering differ from today's per-texture mips | R3-3 onward | Driver `generateMipmap` on a scratch 2D texture + GPU copy per level; byte-equality readback on the 1070, not only SwiftShader; same sampler state. No Rust-built mips; no GPU palette lookup this round. |
| three r184 `layerUpdates` + `generateMipmap` re-mips every layer on each admit | R3-3 | Never use that path; per-layer copy into preallocated capacity. |
| Upload bursts on landblock crossings or crowd spawns (layer admits, row growth, kit geometry: merged entity geometry, per-LB interior batches) | R3-3, R3-4, R3-5 | One byte-denominated per-frame budget for texture and kit-geometry uploads (8 MiB / 16 admits start, after OpenAC); S1 measures admit cost. Static-pool uploads on LB crossings stay uncapped this round and are recorded in S1/S2. |
| FXC compiles (0.5-1.7 s per pixel shader) for the new class programs | R3-3, R3-4 | Register every class in `shader_prewarm.js`; play-time upload draw (R3-2); program-key diff and first-turn hitch in S1; there are fewer programs overall than today's 176-182. |
| Part-mesh consumers break (picking, limbs, dismember, film, `particle_attach`, `weapon_fx`, `play_effect_vfx`, `portal_space`) | R3-4 | Groups stay posed in stage A; side table for picking; K4 inventory before A2; consumer matrix test. |
| Fallback churn when entities fade or go ethereal in combat | R3-4 | Blend-class-keeping mutations write state rows instead of cloning; legacy meshes cached per entity while it lives; fallback rate in hitch frames reported in S1; if it shows, move opacity into the entity row with a translucent class draw. |
| Value-keyed layers merge two palettes that should differ | R3-4 | Key on a hash of the composed bytes plus the did; node test that unequal compositions never share; collision check on full bytes when hashes match. |
| Pose skip misses a pose input (stale pose) | R3-2, R3-4 | Key = (motion descriptor, floored frame, in-place mode); mutation test per key field against the rig parity fixtures. |
| Draw order changes inside an entity, between cells, or across merged particle buckets (coplanar ties, sprite overlap) | R3-4, R3-5, R3-7b | Translucent stays per part/cell and sorted; back-to-front within merged particle buckets; rc-eye structural review; owner eye test. |
| f32 precision at x ≈ 32 km | R3-3 onward | Per-entity and per-landblock origins; camera-relative offsets in f64 on the CPU. |
| Indoor split, stencil and portal passes see different cell sets | R3-5 | Per-pass bit rows; node replay proving bitmask = today's per-pass container set. |
| Lazy interior geometry changes when the cell graph appears, which ACE trusts on the wire | R3-5c | Defer only triangulation and upload; graph outputs keep today's timing; node test on recorded walks that graph outputs and their arrival frame are unchanged. |
| GPU cost behind walls rises after proxies retire | R3-6 | Cell half first, then rig half after batching; priced in GPU ms; Hi-Z pass only if needed. |
| `objRadius=1` drops buildings and trees from the horizon | R3-1, R3-2 | Measure only; default unchanged until owner decision (g); rule R7. |
| Vertex-texture-fetch limits (16 vertex samplers on D3D11) | R3-3 | Few row textures, one per kit; pack rows (pose, part, state). |
| Memory: preallocated pages on the 8 GB laptop (shared iGPU memory) and on the 1070 | R3-3 onward | Preallocate from the census with caps; source 2D textures released after copy-in; bytes reported (`estimateTextureBytes`). |
| GPU fill binds after the CPU work, so fps stays flat | R3-8 onward | M1 measures it up front; rule R5 books main-thread wins as headroom; R3-11 and the governor are ready. |
| Reference clients mislead (different stack scope, content, lighting, hardware) | M1c, M1d, R3-8 | Rule R10: bounds only; quote machine and content; same pose, heading bins and wrapper on both sides. |
| The WebAC run loads the person's box (~1.3 GB tab, ~1.27 GB OPFS writes) or collides with our tab | M1c | One real-world tab at a time; run in an away window; clean up tab, vite, bridge and forwards afterwards. |
| The OpenAC run raises a firewall prompt, plays sound or fails to present off-screen | M1d | Pre-added allow rule; `ACDREAM_NO_AUDIO=1`; frame-count check; optional and owner-approved only (decision (i)). |
| Multi-second stalls return | everything | LoAF window in every anatomy arm; hitch metrics in rule R3; the stall bisect reopens if a valid arm shows a frame ≥ 2 s. |
| A three upgrade breaks `drawExec`'s use of r184 private fields | ongoing | Frozen scope; re-run `tests/draw_exec.test.mjs` on any upgrade. |
| Laptop OOM from parallel heavy jobs (including the OpenAC publish and WebAC's dev server) | all lanes | The `~/CLAUDE.md` rule verbatim in every prompt; one heavy job at a time via `capped-build`; `free -m` ≥ 2.5 GB first. |
| Owner time (sign-offs, eye tests, session windows) | all | One batched eye-test session per 1070 session; decisions listed once in §0. |
