# Rust scene core — moving the per-frame JS into Rust (2026-10-26)

Owner ask: "how much could be moved over to rust so we can start to get headroom for FPS … the more we can move
the better. the goal is to still appear the same visually." Then: "i'm going to have a work flow going all day for
this so we can be pretty extensive here". No 1070 today: everything is built and proven on the laptop (cargo +
node parity tests, GPU smokes on SwiftShader where a render path changes); the fps numbers are owed on the 1070.

Branch `rustcore-2026-10-26`. Evidence tags: **[M]** measured, **[D]** derived, **[C]** code read.

## 1. Where the frame goes today [M]

Source: the three 1070 profiles of 2026-10-23 (`/mnt/wbterminal1/tmp/claude-scratch/perf/gg-grass-gpu-2026-10-23/on-r{1,2,3}-run.cpuprofile`,
ultra, running south from Holtburg, 43–48 fps), bench-only `recordRenderDiag` removed. Main thread **20.6 ms/frame**,
98% busy. Analysis script: `systems.py` (copied into `tools/rust_parity/profile_systems.py`).

| Bucket | ms/frame | Share | Of which |
|---|---|---|---|
| three.js draw loop (`renderScene`) | 6.98 | 34% | three.js JS 4.55, WebGL calls 1.49, our per-draw hooks 0.84 |
| Browser work outside JS (`(program)`) | 3.93 | 19% | not split by these traces (no `devtools.timeline`) |
| three.js scene walk (projectObject, matrix updates, sort) | 2.54 | 12% | three.js 1.26, three math 0.44, our hooks 0.60 |
| Misc per-frame JS (material-variant sync, loop.js / index.js tick bodies) | 1.12 | 5% | |
| Particles (`particle_manager` tick, incl. statics' `_spLoop`) | 1.05 | 5% | |
| Entities tick + rig posing (`poseRigAt`) | 1.01 | 5% | quaternion writes trigger three's Euler sync |
| Terrain VFX, animated scenery, billboards, FX ticks | 0.85 | 4% | |
| Post-processing passes | 0.62 | 3% | |
| HUD JS (vitals orbs, radar) | 0.57 | 3% | DOM |
| wasm today (session / net callbacks) | 0.57 | 3% | already Rust (physics, collision, movement too) |
| Cells/portals, lighting, camera, net pump | 0.54 | 3% | |
| Culling (statics walk, entity visibility) | 0.51 | 2% | |

Chrome's GPU process (CrGpuMain) on the same runs: 14.4–15.1 ms per present (WebGL 9.7–10.1, DOM/HUD raster
3.1–3.4, present 0.8), 63–64% busy [M] → it caps the 1070 at ~67–69 fps once the main thread is faster, unless the
WebGL call volume or the HUD raster drops.

## 2. The approach

**A data move, not a code move.** Every rig part, particle and prop is a three.js object; Rust can only reach them
through JS, so a line-by-line port that keeps the objects pays a JS↔wasm crossing per object and still pays three's
per-object cost. The motion playhead already moved to Rust in June and `poseRigAt` stayed behind for exactly this
reason. The kernels here own their data as flat arrays, do a frame's work in one call, and write flat output buffers
that JS copies into the few three.js objects that draw.

Stages (estimates [D] against the 20.6 ms frame):

| Stage | Moves to Rust | Saves | 1070 fps |
|---|---|---|---|
| 1 | Per-frame systems: particles, rig part matrices, culling, animated scenery, billboards, terrain-VFX CPU loops | 2–3 ms | 45 → ~51 |
| 2 | Static-world residency, transforms and visibility (slot grid, pools, LRU) → three.js holds only pooled draws | 0.6–1.3 ms at Holtburg, 1.3–2.6 ms at Linvak (R2, `2026-10-26-rust-residency-design.md`; most scene-walk nodes are entity rigs, 66% on the laptop census) | → ~53–54 |
| 3 | A Rust draw list + thin executor for the static world, reusing three's compiled programs | ~1.3 ms (0.9–1.7) at Holtburg (R3, `2026-10-26-rust-draw-list-design.md`: exact executor proven in node; material switches ~1.9 ms and GL calls 1.31 ms must be re-applied by any exact executor; fewer GL calls need shader-side UBOs) | → ~57–62 overall |

## 3. The contract (every lane)

- **Crate** `crates/holtburger-scene` — pure Rust, no dependencies, no I/O, no clock reads, no global state.
  `cargo test -p holtburger-scene` builds and tests in ~12 s. One module per lane (`src/<lane>.rs`, a directory is
  fine); `src/lib.rs` lists them (orchestrator-owned).
- **Shared math** `src/math.rs` mirrors three.js r184 operation for operation (Vec3 / Quat / Mat4: compose, multiply,
  invert, decompose, applyQuaternion, applyMatrix4, normalize, axis-angle, Euler XYZ/YXZ, …). Pinned **bit-exact**
  against three.js by `tests/math_parity.rs` (400 random cases; sin/cos-derived values within 1e-15, the V8-vs-libm
  ulp). Need another three.js function? Copy its body into math.rs in the same operation order and add it to
  `tools/rust_parity/gen_math.mjs`. Never "simplify" (`a * (1 / s)` ≠ `a / s`).
- **wasm glue** `apps/holtburger-web/src/scene_wasm/<lane>.rs` — thin `#[wasm_bindgen]` classes over the kernel:
  one call per frame; `*_ptr()` / `*_len()` getters for output buffers; add/remove calls when objects come and go.
  **Never one wasm call per object per frame.** `scene_wasm/mod.rs` exports `sceneCoreAbi()` (orchestrator-owned).
- **JS bridge** `scene3d/rust/scene_core.js` — `sceneWasmClass(name)` (null when the pkg is missing or stale → the
  JS path runs), `WasmF32View` / `WasmU32View` / `WasmF64View` (views that survive memory growth and moved
  pointers), `rustFlag(name, defaultOn)`. Lane bridges live in `scene3d/rust/<lane>.js`.
- **Same pixels.** The Rust path must produce the same values the JS path writes into three.js (instance matrices,
  colours/opacity, visibility, matrices), bit for bit before the f32 store, or within 1 f32 ulp where a value passes
  through sin/cos/atan2/exp/pow. If a JS behaviour is impossible to reproduce exactly, stop and document it; do not
  ship an approximation silently.
- **Randomness and time come in from outside.** Kernels take `now`/`dt` as arguments and draw from a
  `holtburger_scene::rng::Rng`. Production seeds one; parity tests replay the JS reference's exact draws
  (`Rng::scripted`) so draw ORDER is pinned too.
- **Flags.** Each lane ships `?rust<Lane>` (e.g. `?rustParticles`), read with `rustFlag(name, false)` — default OFF
  while in development, `=on` opts in. The JS path stays intact.
  - The flip to default-ON follows the owner's standing rule for validated gates: a same-pixels proof and a bare-URL
    boot with 0 errors.
  - The 2026-10-26 flips (§9) were made that way. The 1070 A/B that can still revert one is queued (batch RC).
  - url-flags.md rows are added by the orchestrator from the lane's notes (the file is shared).

## 4. Parity fixtures (how a lane proves "same values")

1. `tools/rust_parity/gen_<lane>.mjs` runs the **real JS reference** in node (three.js resolves from node_modules;
   stub `window`/`location` as the existing suites do) on scripted scenarios, recording inputs, every RNG draw
   (`recordRng` in `fixture_util.mjs`) and outputs, with floats as hex bit patterns (`f64hex` / `f32hex`). Output:
   `crates/holtburger-scene/tests/fixtures/<lane>*.json`.
2. `crates/holtburger-scene/tests/<lane>_parity.rs` replays them through the kernel (`tests/common/mod.rs`:
   `fixture`, `hex_f64s`, `assert_bits_eq`, `assert_abs`, `ulps_f32`). A missing fixture prints a hint and returns.
3. `tests/rust_<lane>_parity.test.mjs` (node, after the orchestrator's wasm build) drives the JS path and the wasm
   path side by side through the real bridge and compares what lands in the three.js objects. It loads
   `${process.env.HB_PKG || "pkg"}/holtburger_web.js` like `test_motion_sequence_wasm_smoke.mjs` and prints
   `SKIP — …` (exit 0) when the class is missing, so it is harmless before the build.

## 5. Laptop rules for lane agents (CLAUDE.md, verbatim)

> Parallel agents may read, edit and run TARGETED single tests only (`node test_x.mjs`). They must NOT run the full
> JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a
> time.

So a lane writes Rust it cannot compile. The orchestrator runs `cargo test -p holtburger-scene` and the wasm build,
and sends compiler/test output back to the lane. Lanes do not commit, push, or set up any git automation.

## 6. Lanes, owners and status

File ownership is exclusive; a lane that needs a change in another lane's file asks the orchestrator.

| Lane | Scope | Owns | Status |
|---|---|---|---|
| Foundation | crate, math, rng, glue module, bridge, fixtures harness | `crates/holtburger-scene/{Cargo.toml,src/lib.rs,src/math.rs,src/rng.rs,tests/common,tests/math_parity.rs}`, `src/scene_wasm/mod.rs`, `scene3d/rust/scene_core.js`, `tools/rust_parity/{fixture_util,gen_math}.mjs`, index.html `__hbSceneWasm` | done: math bit-exact vs three r184 (400 cases), `cargo test -p holtburger-scene` 8/8 in ~12 s; main wasm builds with it (dev, 2 m 44 s); `tests/rust_scene_core_smoke.test.mjs` 15/15 against the real pkg (ABI handshake, stale-pkg fallback, views across memory growth); `scripts/lint-url-flags.mjs` recognises `rustFlag("name")` readers |
| A Particles | particle sim, emission, kill, RP6 cull, billboards, instanced-bucket packing for instanced emitters | `src/particles/` (10 files), `scene_wasm/particles.rs`, `scene3d/rust/particles.js`, `scene3d/particles/*` | landed; DEFAULT ON since 2026-10-26: `?rustParticles` — every instanced emitter simulated + packed by `SceneParticles`, one call per manager tick; RP6 for frozen anchors in Rust, moving anchors keep the JS test; buckets/kid layers created by JS from an ordered kernel event list (keeps three's object order); kernel emitters build no slot meshes (`parts` built on read). Compiled first try; 20 unit + 7 parity tests: 413,577 floats over 6 scenarios bit-exact (trig buckets 0 ulp). Orchestrator added the pre-boot retry (`rustParticlesPending`). Not exact by design: one clock read at emitter creation, kernel RNG streams (film takes differ from flag-off). |
| B Rig | `poseRigAt` + part local matrices (no Euler sync), then per-entity matrix work | `src/rig.rs`, `scene_wasm/rig.rs`, `scene3d/rust/rig.js`, `scene3d/motion/*`, `scene3d/entities.js` pose call sites | landed; DEFAULT ON since 2026-10-26 (`?rigMeshAlias` stays OFF): `?rustRig` (Rust poses, raw quaternion writes, no Euler sync; one wasm call per posed entity because later code in each entity's tick reads the fresh pose) + `?rustEntityCull` (JS gate hoist, 57 → 16 µs/tick per 200 entities). Node: pose + walk −7% (posing −40%). Kernel compiled first try, 14 unit + rig parity (153 poses, 2,183 parts) bit-exact. Finding: the scene-walk cost per node is writing each node's matrix arrays (~242 ns/node in V8), so moving the multiply to Rust cannot help; the one large lever, identity meshes aliasing their part's matrixWorld (−28…−37% of the entity walk), is not bit-exact (signed zeros, fresher values between walks) → owner decision, docs/2026-10-26-rust-rig.md §7 |
| C Cull | R2's S1b + S1a + S1c, then the statics cull walk and billboards in Rust | `src/cull.rs`, `scene_wasm/cull.rs`, `scene3d/rust/cull.js`, `scene3d/{statics,culling,landblock_lru,static_batch_x,static_atlas,buildings}.js`, `pool_registry.js` | landed; all DEFAULT ON since 2026-10-26: `?anchorOffGraph` (frozen script anchors under per-LB off-graph roots; emitters bit-equal through park/unpark/rebuild/evict), `?staticMatrixFreeze` (frozen after three's walk computed them — freezing at attach was NOT pixel-identical), `?poolSizeToContent` (pools sized to their first feed; orchestrator added the producer `sizeOf`), `?rustCull` (`SceneStaticsCull` verdicts + an event-driven registry; billboards visit only the registry's billboard LODs). Compiled first try; 5 unit + 4 parity (160 frustums' planes bit-equal to three); 25/25 through the compiled wasm incl. `verify()` 0 disagreements; node: JS side of the walk 250–520 → 29–61 µs per 1,700 children. |
| D+E Anim scenery + terrain FX | animated_scenery.js per-frame loop; the terrain-VFX scatter pools | `src/{anim_scenery,terrain_fx}.rs`, `scene_wasm/{anim_scenery,terrain_fx}.rs`, `scene3d/rust/{anim_scenery,terrain_fx}.js`, `animated_scenery.js`, `anim_scenery_gpu.js`, `terrain_scatter.js`, `terrain_{rock,sand,snow,dirt}.js` | landed; all DEFAULT ON since 2026-10-26: `?rustAnimScenery` (mixer step / orbit / GPU pose rows from Rust, one call per frame), `?rustAnimSceneryGate` (JS gate: the loop's real cost was a per-instance graph walk over ~3,400 mostly-parked instances, 323–373 → 66 µs/frame in node), `?rustTerrainFx` (the shared scatter pool's re-scatter plan from Rust for rock/sand/snow/dirt and, applied by the orchestrator, the CPU grass rings; fog skipped — no gain). trail_map (one GL pass) and fx_fields (no per-particle CPU work) left in JS. Compiled first try; the one cargo failure was the fixture test comparing group counts before the frame's disposals; through the compiled wasm anim 21/21, terrain 55/55 (grass 150 frames identical). |
| X Draw executor | R3's S3.1 `?drawExec`, S3.2 `?drawExecRuns`, and (lane's own call) S3.6 `?drawExecRigs` | `scene3d/draw_exec.js`, `batched_runs.js`, `skip_empty_multidraw.js`, `async_link_guard.js`, two lines in index.js | landed; `?drawExec` + `?drawExecRigs` DEFAULT ON since 2026-10-26 (`?drawExecRuns` stays OFF). EXACT: `tests/draw_exec.test.mjs` 228 checks — the full GL call stream identical to stock three + our wrappers, 14 scenarios × 4 arms, 26/27 mutants caught; SwiftShader smoke PASS (8 frames hash-identical per arm, max channel diff 0, glError 0, VAO hand-over fixes exercised). Gain smaller than R3's estimate: the executor's own fast path costs 2.4–3.7 µs/draw (R3 assumed 0.6), continuations −1.3…−2.4 µs, switches ≈ 0, ineligible draws +0.2 µs → ≈ 0.25 ms/frame at Holtburg, ≈ 0.5 with `?drawExecRigs` (entity parts −0.9 µs/draw) [D from node]; runs add ≈ 0. A real-driver `__drawExec.verify(120)` on a boot is owed (VAO semantics). |
| F Hot spots | the per-frame JS no other lane covers (2.76 ms/frame self, long tail) | `batched_material_variant.js`, `draw_sort_program.js`, `cloud_volume.js`, `loop.js`, `night_ramp.js`, `plugins/{vitals-orbs,radar}.js` | landed: 5 exact flags, DEFAULT ON since 2026-10-26 — `?hotMatVariant` (generated straight-line mirrors, ~5× on the 0.24 ms sync), `?hotDrawSort` (same comparator over a per-render-item memo, 1.5–2× on the 0.18 ms sort, order identical incl. ties), `?hotCloudPush`, `?hotTerrainTime`, `?hotNightRamp` — plus 2 direct exact HUD fixes (vitals orbs: reads before writes, 9–11 → 1 forced style recalc per tick; radar: merged rects, −42% fillRect). No Rust: every item is bound to JS objects. Est. 1070 −0.4…−0.55 ms/frame [D]. Not taken: weapon_fx `_syncDelta` (same generated-mirror trick, ~0.03 ms), and a terrain shared-uniform design (500+ terrain materials each get the same per-frame values pushed; one shared `{value}` per frame-constant uniform would make every push O(1) but needs a writer audit). |
| R3 Draw list (research) | design + feasibility of the stage-3 Rust draw list / executor | `docs/2026-10-26-rust-draw-list-design.md` | done: exact executor feasible (6 arms identical to stock three in node over fake WebGL2), ~1.3 ms/frame; first exact step S3.E done by the orchestrator (`batched_runs._frameKey` reads the DOM timeline once per render() per renderer, ~0.09 ms; `tests/batched_runs.test.mjs` +4 checks); the suggested async_link `objectCombo` cache was NOT taken — its inputs (e.g. a late tangent attribute) change without a version bump, so a cache could let a synchronous link through; probe `scripts/perf-worker/drawlist-census.eval.js` + `drawlist_kind_split.py` for the 1070 |
| R2 Residency (research) | design + feasibility of stage 2 (Rust-owned residency, transforms, visibility) | `docs/2026-10-26-rust-residency-design.md` | done: residency itself costs ~0.05 ms/frame; stage 2 ≈ 0.6–1.3 ms Holtburg / 1.3–2.6 ms Linvak; first steps S1a–c are JS-only and pixel-identical (now in lane C); pools hold only the chunk batcher's leftovers; 76 pools allocate ~50 MB of vertex buffers for 0.29 MB used |

## 7. Merge / build protocol (orchestrator)

1. `cargo test -p holtburger-scene` (capped-build) after each lane hand-in; failures go back to the lane.
2. wasm: `env PATH=… capped-build wasm-pack build --target web --out-dir pkg-rustcore --dev` (never into `pkg/`
   mid-day: serve.py hands `pkg/` out), then `HB_PKG=pkg-rustcore node tests/rust_<lane>_parity.test.mjs`.
3. End of day: one `--release` build → back up `pkg/` → rsync; bump the `wasmrev-` stamp (index.html,
   bake_worker.js, net_worker.js, net_worker_client.js); full JS gate once; url-flags rows; handoff + the 1070 queue.

## 8. The "(program)" bucket — still unattributed

The ~3.9 ms/frame of native main-thread work (19%) cannot be split from the 10-23 traces (categories `gpu,toplevel`
only). A laptop attempt (2026-10-26, `scripts/perf-worker/laptop-timeline-probe.mjs` + `timeline_split.py`,
`?nullRender=1` to keep SwiftShader out of it, run dir `/mnt/wbterminal1/tmp/claude-scratch/perf/timeline-nullrender-20261026a`)
is NOT representative: headless Chrome ran the frame loop at ~0.4 Hz with nothing drawn (4 frames in 9 s), and the main
thread was 29% busy — worker messages from a still-streaming world (`Receive mojo message` 1.88 s) and GC (0.67 s);
style 5 ms, layout 2 ms, paint+composite 15 ms over the whole window (DOM 1,851 nodes, 13 running CSS animations).
Owed on the 1070: one `gputrace.mjs` run with categories
`devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink,v8.execute,toplevel`
during the running bench, read with `timeline_split.py --frames N`. It decides whether the HUD/DOM (style, layout,
paint, compositing) or the GPU command-buffer flushes are the lever behind those 3.9 ms; neither is a Rust question.

Partial answer from an older 1070 trace that does carry `devtools.timeline`
(`/mnt/wbterminal1/tmp/claude-scratch/perf/firstturn-trace.json`, 2026-10-06, mid, the first camera sweep after boot;
`timeline_split.py`): over 12.7 s the page's main thread spent 26 ms in style (`UpdateLayoutTree`), 1.4 ms in layout
and ~62 ms in paint + compositing, i.e. well under 0.1 ms/frame for the DOM HUD's style/layout/paint. Its non-JS time
was ~5.6 s of waiting on the GPU process (`CommandBufferProxyImpl::WaitForGetOffset` 5.06 s, `WaitForToken` 0.56 s),
expected during the first-turn shader compiles. So the 3.9 ms/frame of `(program)` in the steady running profiles is
very unlikely to be HUD style/layout/paint; the likelier contents are V8/Blink binding and scheduler overhead around
the ~thousands of WebGL calls per frame (fewer calls is the only lever) — still to be confirmed with the steady-state
trace above. (Lane F's vitals-orbs fix removes 8–10 forced style recalcs per orb tick, the one HUD item that was
measurable.)

## 9. Build state (orchestrator)

- 10:27 — release wasm with every lane (`wasm-pack build --release`, 7 m 12 s): 7,692,096 B (the previous pkg/ was
  7,637,090 B: +55 KB for the whole scene core). Every `tests/rust_*` suite passes against it
  (`HB_PKG=pkg-rel-20261026`): scene core 15/15, particles 8/8, rig 60/60, cull 25/25, anim scenery 21/21, terrain FX
  55/55, and the pre-existing `test_motion_sequence_wasm_smoke.mjs` 17/17 (the old exports are intact).
- Installed into `pkg/` (previous kept as `pkg-prev-20261026-prerustcore/`); cache stamp `wasmrev-20261024d` →
  `wasmrev-20261026a` in index.html, bake_worker.js, net_worker.js, net_worker_client.js.
- `cargo test -p holtburger-scene`: 35 unit tests + every lane's parity suite green.
- Cargo features: one per lane (`holtburger-scene` `lane-*`, `holtburger-web` `scene-*`, all default) so a finished lane
  builds while others are mid-edit: `cargo test -p holtburger-scene --no-default-features --features lane-rig`,
  `wasm-pack build … -- --no-default-features --features scene-rig`.
- 10:45 — laptop boot smokes against the installed release pkg (`scripts/perf-worker/laptop-rust-boot-smoke.mjs`,
  SwiftShader, ultra, renderScale 0.5, bot agentp10, run dirs `/mnt/wbterminal1/tmp/claude-scratch/perf/rust-boot-smoke-{bare,rust-all}`):
  - bare URL (every new flag off): in-world in 59 s, 0 console errors, 0 page errors.
  - every lane flag on: in-world in 74 s, 0 console errors, 0 page errors, 0 Rust warnings, and each kernel engaged —
    rustRig 302 rigs / 5,410 parts posed by Rust, 0 JS fallbacks; rigMeshAlias 122 meshes sharing; rustCull 174 slots,
    `verify()` 176/176 agree, 0 plane mismatches; rustTerrainFx 4 pools on the planner, 44,594 instances placed, 0
    failures; particles 740 of 740 instanced emitters on the kernel, slot carriers 3,158 → 0. rustAnimScenery not
    exercised (no animated scenery at the bot's spawn; the smoke now takes `--telepoi <POI>`).
- 11:35 — every flag on (incl. drawExec + drawExecRigs + lane F's five) teleported to Holtburg at ultra: booted in
  38 s, then the SwiftShader renderer was SIGTERMed by earlyoom at ~182 s (system 12% available: the woken ACE server
  ~1 GB + six review agents + a 3.2 GB capped Chrome). Not a code fault (`/var/log/earlyoom.log`); re-run lighter
  (quality high, renderScale 0.25) once the reviews are done.

- 13:30 — release wasm with every review fix (`pkg-rel-20261026b`, 5 m 52 s): 7,697,244 B. Every `tests/rust_*`
  suite passes against it: scene core 15/15, particles 20/20, rig 60/60 (`--expose-gc`), cull 25/25, anim scenery
  41/41, terrain FX 55/55, motion-sequence smoke 17/17. `draw_exec` 283/0, and its SwiftShader pixel smoke PASSes with
  `vaoFixLate` 0. Installed into `pkg/`, with the 10:27 build kept as `pkg-prev-20261026-1027/`; stamp
  `wasmrev-20261026b`.
- 14:00 — Holtburg boots (SwiftShader, high, renderScale 0.25, `@telepoi Holtburg`):
  - Every flag on: 0 console / page errors, every kernel engaged. `__drawExec.verify(20)` ran 9,813 checks with
    0 fails, and `rustCull.verify()` agreed 1,559/1,559.
  - Bare URL: 0 errors. It also carried R3's census: 1,392 world-pass draws a frame (cellstatic 442, entity_part
    388, bucket_unsorted 169, cell_surface 145, …). The occlusion culler had not converged at ~0.1 fps, so the cell
    and entity counts are upper bounds.
  - A laptop CPU / fps A/B is not possible: about 1 frame per 10 s at Holtburg.
- 14:10 — **DEFAULT-ON flip** under the house rule (validated gates ship default-on with an `=off` escape) for the
  17 exact, validated flags:
  - `rustParticles`, `rustRig`, `rustEntityCull`, `anchorOffGraph`, `staticMatrixFreeze`, `poolSizeToContent`,
    `rustCull`, `rustAnimScenery`, `rustAnimSceneryGate`, `rustTerrainFx`, `drawExec`, `drawExecRigs`,
    `hotMatVariant`, `hotDrawSort`, `hotCloudPush`, `hotTerrainTime`, `hotNightRamp`.
  - Still OFF: `rigMeshAlias` (owner decision) and `drawExecRuns` (no gain). Both were DELETED on 2026-10-30 (round 3 R3-2): `rigMeshAlias` after it measured as a 1070 loss (RC-BENCH v2 rep 1), `drawExecRuns` for no gain (docs/2026-10-29-round3-gpu-driven.md).
  - The 1070 A/B and eye check are queued with decision rules written beforehand:
    `docs/reengineering/queue-1070/batch-RC-rust-scene-core-2026-10-26.json`. Handoff:
    `docs/HANDOFF-rust-scene-core-2026-10-26.md`.
- 14:40 — full JS gate on the new defaults: 916 / 920. All four failures were tests pinned to the old default-off
  readers or to the pre-`anchorOffGraph` anchor layout, and they now force the arm they test. Three are fixed
  and green; `draw_exec`'s two reader checks are with lane X2. The bare-URL Holtburg boot on the defaults was clean
  (0 errors, every kernel engaged).

- 2026-10-29 — handoff steps 0–7 closed (`docs/HANDOFF-rust-scene-core-2026-10-29.md`): RC-BOOT on the 1070 (`drawExec`
  verify 0 fails over 115k checks; census 1,079 draws/frame); release `pkg-rel-20261029b` (SceneWorld + lane W fixes,
  stamp `wasmrev-20261029b`); full JS gate 925/925; round-2 review (9 confirmed, all fixed and independently verified,
  incl. a pre-existing default-path `?objRadius` pool-hide pixel bug). First real-GPU numbers: stage 1 saves −2.72 ms/frame
  main thread (3 profile pairs) and reads +8 fps over all-off (RC-BENCH v2 rep 1); `rustParticles` costs +1.13 ms and is
  DEFAULT OFF again. Round 3 is re-planned GPU-driven: `docs/2026-10-29-round3-gpu-driven.md`.

## 10. Reviews

Adversarial review per lane group (Workflow: one finder per dimension, two skeptics per finding that try to refute it;
a finding counts only when neither skeptic refutes it).

- **A + B** (28 agents): 12 findings, 7 confirmed, 0 contested, 5 refuted. Lane B (rig): nothing confirmed. Lane A
  (particles), sent back to the lane: (1) the bridge's route table never drops a route, so base materials evicted by
  `?matBudgetMB` and their pixel buffers stay reachable for the session; (2) with the non-default
  `?particleOwner=off`, a same-id create race orphans a shell whose finish then removes the live emitter's table
  entry; (3) dynamic shells resolve their anchor every tick while culled (0.71 → 2.60 ms/tick in a 300-emitter repro);
  (4) film mode materializes proxy slot meshes for every emitter every frame; (5) tier-1 FX lights make one
  `emitterState` wasm round trip per lit shell per frame. Orchestrator fixed the seventh: the boot modulepreload block
  (6 new modules; `harness/test_build_shell.mjs` pin 427 → 433, 64/64).
  Lane A's fixes (round 2): routes freed at refs 0 and their ids reused; the same-id overwrite removes the orphan and
  gives the newcomer its kernel position (`addEmitterAt`); anchors skipped on culled persistent ticks and on
  per-second ticks with no free slot; film mode served by a mesh-free per-tick `filmSample()`; shell fields read from
  a per-handle `state_out` buffer (no `emitterState` call per read). Every regression check fails with its fix
  reverted. Compiled first try; `cargo test -p holtburger-scene` green (8 particle parity tests, each fixture also
  replayed with only the bridge-gated anchors); `tests/rust_particles_parity.test.mjs` 20/20 through the compiled
  kernel, no SKIP; particle + film suites green.
- **X + F** (15 agents): 6 findings, 1 confirmed, 1 contested, 4 refuted. Confirmed (lane F): `?hotDrawSort`'s memo
  stored object/material references on three's pooled render items, which three's `finish()` deliberately clears, so
  evicted meshes stayed reachable (repro: 199/199 alive, 79 MB vs 1/199, 10 MB) — sent back: store ids, read the
  material live. Contested (lane X, minor, no pixel effect): a zero-instance draw between executed statics can leave a
  redundant VAO bind different from stock — sent back to evaluate the proposed exact fix. Lane X otherwise clean.
- **C + D+E**: 12 findings, 5 confirmed, 1 contested, 6 refuted. Sent back to lane C: (1) `?staticMatrixFreeze` — an
  LOD wrapper that froze leaves its band levels queued when they were hidden at their check (two scene walks in one
  frame under the indoor split, or a missed 512-check window); after an evict their parent is the detached wrapper, not
  null, so they are never dropped and `_pendingFreeze` grows every bake/evict cycle (repro 328 → 1,106 over 5 cycles;
  pixels unaffected, a heap leak); (2) `?anchorOffGraph` + `?filmMode` — the film scene-settle and pop-in signatures
  count `staticsGroup.children`, which no longer holds the anchors. Sent back to lane D+E: (3) `?rustAnimScenery` — two
  concurrent `getOrCreateDidGroup` calls for one DID (unawaited cells attach + up to 6 bakes in flight) leave the
  map-dropped group in the kernel, advancing forever, and rows registered later bind to it (lowest slot with the key)
  → pose rows differ from flag-off (repro 72–144 floats); found independently by two finders. Contested (1 of 2):
  `rustAnimFallback` reads its clocks from the last advance's view, which memory growth detaches; reachable only after
  a trap in another kernel method (OOM), but the fix is two float copies per group per frame, so it is taken. The boot
  modulepreload finding was already fixed.
  Fixes (round 2): lane C — the freeze tick drops any queued object no longer under a `THREE.Scene` (`_underScene`,
  the general form), so the repro's queue goes 600 → 0 after every evict; both film signatures add the off-graph
  roots' children, so flag-on totals equal flag-off at every attach / park / unpark / evict
  (`static_matrix_freeze` 54/54 with a two-walks-a-frame arm, `anchor_off_graph` 8/8, film suites green; each new
  check fails on the pre-fix code). Lane D+E — the map-dropped group leaves the kernel when the map drops it (new
  group registered first), and the kernel now binds a new row to the latest live group of its key and leaves rows
  unbound on unregister (cargo `rows_follow_the_latest_group_of_a_key`); the fallback reads per-group clock
  snapshots taken while the view is fresh, and poisons three's change-detection buffers so the handed-back mixer
  rewrites every part (`rust_anim_scenery_parity` 41/41; the reviewers' five repros all report kernel = map and 0
  differing floats). `cargo test -p holtburger-scene`: 36 unit + every parity suite green.
