# HANDOFF — Rust scene core, stage 1 + the draw executor (2026-10-26)

Owner ask: "how much could be moved over to rust so we can start to get headroom for FPS … the more we can move
the better. the goal is to still appear the same visually." No 1070 today, so everything below is proven on the
laptop: cargo and node parity suites through the compiled wasm, plus SwiftShader boots. The fps numbers are owed
on the 1070: `docs/reengineering/queue-1070/batch-RC-rust-scene-core-2026-10-26.json`.

Plan, lanes, reviews and build log: `docs/2026-10-26-rust-scene-core.md`.

Branch `rustcore-2026-10-26` holds one LOCAL checkpoint commit of the whole day ("Rust scene core — WIP checkpoint").
It is not pushed, and round 2 in it is not reviewed. The real commit + push comes after the checklist below.

`scripts/proxy.cjs` is left uncommitted on purpose. Its change is an earlier session's tunnel-socket fix
(2026-10-25 02:38), not this work; commit it on its own when that session's owner says so.

## RESUME HERE (owner paused 2026-10-26 evening: usage; "we arent skipping things or trimming our plans")

> **2026-10-29: steps 0–7 are done — continue from `docs/HANDOFF-rust-scene-core-2026-10-29.md` (RESUME HERE there).** Step 8's S4 `?rustWorldLists` and "round 3" are superseded by the GPU-driven round 3, `docs/2026-10-29-round3-gpu-driven.md`.

Nothing is trimmed. Finish the plan as written, in this order, one heavy job at a time (~/CLAUDE.md rules).

0. **Bring the laptop up if it rebooted.** ACE and `serve.py` die on a reboot (runbook `memory/ace-live.md`):
   - `ss -ulpn | grep -E ':900[01]'` (ACE) and `ss -ltnp | grep 8765` (serve.py) must both answer;
   - `git status` must show the branch `rustcore-2026-10-26`;
   - `ls -la apps/holtburger-web/pkg/*.wasm` must read 7,697,244 B (the 13:30 release).
   - Scratch evidence: the session scratchpad was copied to `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-26-scratch/`.
     It holds review repros (`review/`, `review2/`, `review3/`), the review JSONs (`review_*.json`), mutant runners
     (`mut*/`), lane R4's harness (`r4/`), profiles and backups. Lane reports that cite `/tmp/claude-1000/...`
     mean this copy.
1. **Re-validate the draw executor.** Lane X2 changed `draw_exec.js`, which is DEFAULT ON, after the gate and smokes.
   - `capped-build node harness/glsl_smoke/draw_exec_smoke.mjs` (5 arms, PASS needs `vaoFixLate` 0);
   - one Holtburg boot with `scripts/perf-worker/laptop-rust-boot-smoke.mjs --telepoi Holtburg --settle-sec 90 --flags ''`.
     First add these reads to the smoke's diag block, the way `__rustWorld` was added:
     - `await __drawExec.census(60)`;
     - `await __drawExec.verify(120)` with `fails: 0` and `checks > 0`; verify only after the teleport has
       settled, or it checks no draws;
     - `__drawExec.stats.texDemoted`, which must be 0.
2. **One release wasm build** (it adds lane W's `SceneWorld`): `wasm-pack build --target web --out-dir
   pkg-rel-<date> --release` under capped-build. Then:
   - re-run every `tests/rust_*` suite with `HB_PKG`;
   - install into `pkg/`, backing up the current one;
   - bump `wasmrev-20261026b` in index.html, bake_worker.js, net_worker.js and net_worker_client.js.
3. **Full JS gate once** (`capped-build node harness/run-js-headless.mjs --quiet`). Last run: 916/920, and the 4 failures
   are fixed. Also re-run `harness/test_build_shell.mjs`: its "identical across builds" check raced a lane's edits.
   `NON_APP_PRELOADS` is 436 (457 modules).
4. **Lane W's owed check:** a SwiftShader boot with `--flags 'rustWorld=on' --telepoi Holtburg --hop Shoushi`, and
   `__rustWorld.audit()` 0 mismatches / 0 integrity after the hop. The first try was OOM-killed: run it with nothing
   else open, and close other Chrome tabs first.
5. **The adversarial review of round 2** (Workflow, as for round 1: a finder per dimension and 2 skeptics per finding).
   Lanes: W (`rustWorld`), R4 (`rustEntityWorld`), X2 (the executor changes), F2 (`hotTerrainShared`,
   `hotWeaponFxSync`, `hotGrassCull`). Send each lane's confirmed findings back to it (fresh agents with that lane's
   notes doc), fix them, then re-run that lane's suites.
6. **Apply the two one-line findings**, each with a test:
   - the atlas GC `bm.dispose()` leak (lane W, `static_atlas.js` `tickStatAtlasOptimize`);
   - `"use strict"` in `hotMatVariant`'s generated mirror (lane F2 finding, `batched_material_variant.js`).
7. **Commit + push** the branch `rustcore-2026-10-26` to `origin` (the owner's fork; never `main`), with the
   Co-Authored-By line. Squash or keep the checkpoint commit as the owner prefers.
8. **Then the rest of the plan:**
   - lane W's S4 `?rustWorldLists` (brief in this file §In flight, and R2 §4);
   - round 3 (plan §6 / R2 / R3 next steps);
   - the owner's 1070 session `docs/reengineering/queue-1070/batch-RC-rust-scene-core-2026-10-26.json`.
     Its arms predate round 2: add `rustEntityWorld=on` and the three F2 flags as arms.

## Status

**17 flags DEFAULT-ON since 2026-10-26**, each with an `=off` escape. They follow the house rule for validated
gates: exact parity, bare URL loads, spawns, 0 errors.

| Flag | What runs instead of the JS | Exact? | Node / laptop evidence |
|---|---|---|---|
| `rustParticles` | instanced emitters simulated and packed by `SceneParticles`, one call per manager tick | same distributions; own RNG streams, so film takes differ from flag-off | 413,577 floats over 6 fixtures bit-exact; Holtburg: 3,016 / 3,016 emitters on the kernel, slot carriers 13,307 → 0 |
| `rustRig` | rig part poses from `SceneRigs`, one call per posed entity | bit-exact | 153 poses / 2,183 parts; Holtburg 3,011 rigs posed, 0 JS fallbacks |
| `rustEntityCull` | the entity tick gate without the ancestor walk | bit-exact | 57 → 16 µs/tick per 200 entities |
| `anchorOffGraph` | frozen script anchors under per-LB off-graph roots | bit-exact emitters | park / unpark / rebuild / evict; film signatures count the roots |
| `staticMatrixFreeze` | static nodes stop recomposing matrices after three's walk computed them | bit-exact | 54 checks incl. two walks a frame; queue drains on evict |
| `poolSizeToContent` | pools sized to their first feed | same draws | ~45 MB less vertex buffer at Holtburg (R2 estimate) |
| `rustCull` | the statics cull's sphere / horizon tests in `SceneStaticsCull` | bit-exact verdicts | Holtburg `verify()` 1,559 / 1,559 agree, 0 plane mismatches |
| `rustAnimScenery` | the animated-scenery mixer step / orbit / GPU pose rows, one call per frame | bit-exact | 41 checks incl. the concurrent-attach race; Holtburg 4 groups, 923 instances |
| `rustAnimSceneryGate` | the rAF gate without the per-instance graph walk | bit-exact | 323–373 → 66 µs/frame |
| `rustTerrainFx` | the scatter pools' re-scatter plan (rock / sand / snow / dirt + CPU grass) | bit-exact | 55 checks, grass 150 frames identical; Holtburg 43,100 instances, 0 failures |
| `drawExec`, `drawExecRigs` | a thin exact executor for stable world draws (statics, cells, terrain, rigid entity parts) | identical GL call stream | 283-check identity suite (29 / 31 mutants); pixel smoke 8 frames hash-identical; Holtburg real-driver `verify(20)` 9,813 checks, 0 fails |
| `hotMatVariant`, `hotDrawSort`, `hotCloudPush`, `hotTerrainTime`, `hotNightRamp` | exact JS rewrites (generated mirrors, memoised comparator, one uniform lookup per material) | identical values / order | lane F suites |

Plus two direct HUD fixes (no flag): vitals orbs read before they write (9–11 → 1 forced style recalc per tick), and
the radar merges its rects (−42 % fillRect).

**Still OFF**:
- `rigMeshAlias`: exact at every walk, not between walks, so it is the owner's call. The node estimate is
  0.05–0.10 ms/frame.
- `drawExecRuns`: no gain.

**Expected effect on the 1070 [D, node]:** stage 1 should save ~2–3 ms of the 20.6 ms main-thread frame
(45 → ~50 fps where the main thread limits). CrGpuMain sees the same GL commands, and it caps the 1070 at
~67–69 fps.

## Turning it off

Any lane: `?<flag>=off`. Everything at once: the queue file's `allOffFlags`. A pkg without the scene core (or a stale
one) falls back to the JS paths silently; `sceneCoreAbi()` must read 1.

## Build state

- `pkg/` holds the release wasm of 13:30 (7,697,244 B; `wasm-pack build --release`, 5 m 52 s).
  - The previous release is kept in `pkg-prev-20261026-1027/`; the pre-scene-core one in
    `pkg-prev-20261026-prerustcore/`.
  - Cache stamp `wasmrev-20261026b` in index.html, bake_worker.js, net_worker.js and net_worker_client.js.
- `cargo test -p holtburger-scene`: 36 unit tests and every parity suite green.
- Node suites against the release pkg:
  - rust_scene_core_smoke 15/15
  - rust_particles_parity 20/20
  - rust_rig_parity 60/60 (`--expose-gc`)
  - rust_cull_parity 25/25
  - rust_anim_scenery_parity 41/41
  - rust_terrain_fx_parity 55/55
  - test_motion_sequence_wasm_smoke 17/17
  - draw_exec 283/0
  - build shell 64/64
- Full JS gate with the new defaults: see §Gate.

## Laptop boots (SwiftShader, high, renderScale 0.25, bot agentp10, `@telepoi Holtburg`)

- Every flag on (`rc-all-holt-r1`): in-world in 31 s, 0 console errors, 0 page errors, 0 Rust warnings, every
  kernel engaged. Run dir: `/mnt/wbterminal1/tmp/claude-scratch/perf/rust-boot-smoke-rc-all-holt-r1`.
- Bare URL (`rc-bare-holt-r1`, before the flips): 0 errors. It also ran R3's draw-list census:
  - **1,392 world-pass draws a frame**: cellstatic 442, entity_part 388, bucket_unsorted 169, cell_surface 145,
    occlusion 64, static_mesh 58, pool_opaque 23, …
  - SwiftShader ran at ~0.1 fps, so the occlusion culler had not converged; the cell and entity counts are upper
    bounds. The 1070 census (RC-CENSUS) decides.
- Entity parts at Holtburg: 138–176 visible meshes over 93–111 materials, and only 4 of 128 (geometry, material)
  pairs are shared. Instancing identical parts would buy nothing.
- No laptop fps or CPU A/B is possible: the frame loop runs at one frame per ~10 s at Holtburg on SwiftShader.

## Reviews

Three adversarial rounds, each a finder per dimension plus two skeptics per finding:

| Round | Findings | Confirmed | Fixed |
|---|---|---|---|
| A + B | 12 | 7 | all |
| X + F | 6 | 1 + 1 contested | both |
| C + D+E | 12 | 5 + 1 contested | all |

Details are in plan §10. The two divergent executor repros lane X left need an object hook that touches GL state,
and no product hook does today. Lane X2 is hardening them.

## Gate

- **Full JS gate with the new defaults** (`capped-build node harness/run-js-headless.mjs --quiet`, 11 min, log
  `/mnt/wbterminal1/tmp/claude-scratch/perf/jsgate-rustcore-defaults-20261026.log`): **916 / 920 passed**. The 4
  failures were tests pinned to the old default-off flags:
  - `harness/test_draw_pools.mjs`: the M6 byte census now has both arms;
  - `tests/static_anchor_radius.test.mjs` and `tests/static_script_radius_race.test.mjs`: their worlds use the
    pre-`?anchorOffGraph` anchor layout, so they pin that flag off; `anchor_off_graph` A3 / A5 / A6 cover the flag-on
    arm of park / unpark / rebuild, the radius tick and a park during the part-frame await;
  - `tests/draw_exec.test.mjs`: two default-reader checks, being fixed by lane X2.
  The first three were rerun green after the fix, together with the other readers' tests that were touched
  (`pool_size_to_content`, `static_matrix_freeze`, `anchor_off_graph`, the four `hot_*` suites).
  Known gap: the race suite's R1–R9 run only the legacy layout.
- **Bare URL with the new defaults** (`rc-defaults-holt-r1`, SwiftShader, `@telepoi Holtburg`):
  - in-world in 59 s, 0 console errors, 0 page errors, 0 Rust warnings;
  - particles 1,062 / 1,062 emitters on the kernel;
  - rigs 1,824 posed by Rust, 0 fallbacks;
  - `rustCull.verify()` 724 agree, 0 disagree;
  - anim scenery 4 groups, 0 failures;
  - terrain FX 48,639 placed, 0 failures.
  The executor's `verify(20)` window fell inside the teleport settle and checked no draws. The all-flags boot above
  ran the same code with 9,813 checks and 0 fails.

## In flight (round 2, started 2026-10-26 afternoon)

- **W, finished S0 + S2; default OFF; notes in `docs/2026-10-26-rust-world.md`.**
  - What landed:
    - S0: the structural census and the event recorder.
    - S2, `?rustWorld` shadow mode: `SceneWorld` mirrors chunk / atlas buckets, pools, building batches and residency
      (LRU, slot grid, pool registry, objRadius, cell PVS), and audits itself against three and the JS state at 1 Hz.
    - About 35 flag-gated hook lines in the producers.
  - Cargo: 12 new unit tests and 4 parity tests (`world_parity.rs`), all green. The crate is at 48 unit tests.
  - `tests/rust_world_shadow.test.mjs` (gate tier 5): 122/122 through the compiled kernel (dev build `pkg-rustcore/`).
    Every scenario audits 0 mismatches, and the 35 hook knock-out mutants are all caught.
  - 97 suites that load a hooked file give identical results with the hooks armed and with them off.
  - SwiftShader boot with `?rustWorld=on` (dev pkg swapped in, then restored):
    - at Holtburg: 53 audits over 20,217 events, all 0 mismatches and 0 integrity errors;
    - after the `@telepoi Shoushi` hop: no reading. earlyoom killed the renderer (system at 12% available,
      `/var/log/earlyoom.log`), a laptop memory limit rather than the code. **That check is still owed.**
  - **S4 (`?rustWorldLists`) is not started.** It is gated on S2 being proven; the hop check above is its last item.
    Lane W notes that `?staticEarlyOut` (default ON) already skips three's rebuild for unsorted chunk buckets on
    settled frames, so S4 mostly saves change frames. Measure on the 1070 first.
  - Lane W finding, not fixed: the atlas empty-bucket GC (`static_atlas.js` `tickStatAtlasOptimize`) never calls
    `bm.dispose()`, so every GC'd bucket leaks its matrices and indirect DataTextures on the GPU. The fix is one line
    after its geometry dispose.
  - Orchestrator wiring done:
    - `lane-world` / `scene-world` features (default) and the `mod world` lines;
    - the gate entry;
    - the modulepreload block regenerated: 457 modules, `NON_APP_PRELOADS` 436, which also counts
      `entity_world.js` (R4) and `terrain_shared_uniforms.js` (F2);
    - the `rustWorld` url-flags row.
  - The release `pkg/` does not contain `SceneWorld` yet. The next release build will include it.
- **R4, finished; notes in `docs/2026-10-26-rust-entity-walk.md`.** It shipped `?rustEntityWorld`, default OFF and
  exact. It is JS only: every Rust variant measured lost.
  - Node, Holtburg-shaped (19 visible rigs), per frame:
    - entity matrix walk 231 µs;
    - projectObject 344 µs;
    - sort 122 µs;
    - draws 1,471 µs (6.2 µs per visible mesh, mostly material switches).
  - The flag runs a rig-aware matrix walk with three's math inlined, and a projection stand-in for the main scene
    that pushes unchanged meshes where three would.
  - Effect: entity matrix walk −30…−36%, entity projectObject −23…−28%, entity scene walk −23…−26%
    (195–250 µs/frame). That is ≈ 0.1–0.25 ms/frame on the 1070 [D].
  - Evidence:
    - `tests/rust_entity_world.test.mjs` 84/84: identical matrices after every walk; the full GL call stream, info
      and sorted render lists identical over 11 scenarios; 26/31 mutants caught;
    - 35 rig / entity suites pass with the flag forced on and off.
  - Measured and dropped:
    - (a) Rust-written matrices: copy-back makes the walk 26% slower; wasm-memory views save 9% but add 35 µs to
      the draws, and memory growth silently invalidates them.
  - Estimated only, both owner decisions with eye tests:
    - (c) per-entity same-material merge: −30…−40% entity draws, ≈ 0.3–0.4 ms;
    - (d) per-entity texture arrays: −85…−90%, ≈ 1–1.7 ms, but resampled textures.
  - The lane's call: keep it OFF until a 1070 A/B shows the node gain survives Chrome.
  - Wiring: the modulepreload block already includes `entity_world.js`, and the url-flags row is in.
- **X2, finished; notes in `docs/2026-10-26-rust-draw-exec.md` §9.** These changes land on `?drawExec`, which is
  DEFAULT ON.
  - Robustness, both lane-X repros now identical:
    - a texture-bind epoch demotes a lit continuation to the state-only path after a foreign `bindTexture`;
    - a VAO content generation invalidates a record after any re-setup, which is exact through the new
      `noPosition` refusal.
  - Coverage: the occlusion proxies are executed, and empty multi-draws take the wrappers' path up front.
    `await __drawExec.census(frames)` gives every draw by kind / outcome / reason.
  - Fast path: cached three texture properties, a per-mesh batched_runs cache, and the executor skips its own GL
    hooks. A BatchedMesh continuation is 1.93 → 1.34 µs/call (−2.11 vs stock).
  - Node town-shaped frame (628 draws): executed share 77.0 → 86.6 %; −0.75 ms/frame vs stock inside
    renderBufferDirect.
  - Suite `draw_exec` 401/0 over 22 scenarios, 61/63 mutants caught. The default-reader checks are fixed: ON by
    default, `=off` escapes, and every arm forces its flags.
  - The smoke now has 5 arms (one is the shipped default) and has passed `--check`.
  - The url-flags `drawExec` row is replaced with the lane's §9.7 text.
  - **Owed before any commit (X2 changed a DEFAULT-ON path after the gate and smokes):**
    - `capped-build node harness/glsl_smoke/draw_exec_smoke.mjs`;
    - one Holtburg boot: `await __drawExec.census(60)`, `await __drawExec.verify(120)` with `fails: 0`, and
      `__drawExec.stats.texDemoted` 0;
    - the full JS gate.
- **F2, finished; notes in `docs/2026-10-26-rust-hotspots-2.md`.** Three exact flags, all default OFF, ≈ −0.13…−0.15
  ms/frame on the 1070 together [D].
  - `?hotTerrainShared`: one shared `{value}` per frame-constant terrain uniform (uTime, uCrackGlowBreath, uSunDir,
    the 4 cloud-shadow uniforms), with a full writer / reader / cloner audit. Node, 541 materials: 124 → 5.2 µs/frame;
    ≈ −0.09 ms on the 1070.
  - `?hotWeaponFxSync`: a generated strict mirror for `_syncDelta`. `tickWeaponFx` 71 → 24 µs per 40 weapons.
  - `?hotGrassCull`: the GPU grass tile cull keeps its per-ring height answers until the terrain field's new
    `generation()` stamp or the ring window moves. Ring culls 29.5 → 14.8 µs/frame.
  - Tests: `hot_terrain_shared` 8/8, `hot_weapon_fx_sync` 5/5, `hot_grass_cull` 5/5, all in the gate (tier 5);
    28/29 rule-break mutants caught; nine existing suites pass flag-off and forced-on. The url-flags rows are in.
  - Not taken, with reasons in the doc: occlusion_cull (GL query calls must stay), uniform_bind_patch / runPerCamera
    wrappers, the vitals-orbs and night_ramp residuals, terrain_oracle, atmosphere `_lateNow`.
  - The IBL push in `ibl_environment.js` (≈ 0.013 ms) has its helper and tests ready; the 3-edit patch is in doc §G1.6.
  - **Findings for later:**
    - lane F's generated mirror in `batched_material_variant.js` (`?hotMatVariant`, now DEFAULT ON) is compiled
      without `"use strict"`: a write that throws in the module's `_mirror` would pass silently in the mirror. The fix
      is to prefix the body with `"use strict";\n`; it is not applied (hold).
    - `performance.now()` wrappers add up to ~85 µs/frame in the 1070 profiles (~3 µs a call), which points at a
      slow clock source on that box. A console loop timing `performance.now()` there would confirm it.

## Next for the owner

1. The 1070 session in `batch-RC-rust-scene-core-2026-10-26.json`, in this order:
   - RC-BOOT, RC-BENCH, RC-PROFILE, RC-TRACE, RC-CENSUS, RC-EYE.
   - The decision rules were written before the run. A failing lane goes back to default OFF by one reader line.
2. Decide `rigMeshAlias` from RC-BENCH's `rc-alias-ultra` arm.
3. Say whether to commit this branch. Nothing is committed or pushed.
