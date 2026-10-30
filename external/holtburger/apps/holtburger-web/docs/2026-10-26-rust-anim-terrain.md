# Lanes D + E — animated scenery and terrain-VFX per-frame work in Rust (2026-10-26)

Part of the Rust scene core effort: [2026-10-26-rust-scene-core.md](2026-10-26-rust-scene-core.md) (plan,
contract, lane table). Evidence tags as there: **[M]** measured, **[D]** derived, **[C]** code read.

## 1. What shipped

| Flag | Default | What it does | Exact? |
|---|---|---|---|
| `?rustAnimScenery=on` | off | The per-DID template pose of the DAT-animated scenery in ONE wasm call per frame (`SceneAnimScenery.advance`): three r184's `AnimationMixer` step (action time + LoopRepeat wrap, the interpolant seek, lerp / `slerpFlat`, the PropertyMixer accu interleave), the retail SetOmega orbit, and the `?animSceneryGpu` pose-table rows (compose, × the unbake `post`, the orbit rotation, f32 store). JS writes the template parts back (position + the quaternion's raw `_x.._w`) and the orbit, and copies the rows the kernel wrote into anim_scenery_gpu.js's table. | Yes: positions, clocks, orbit angles bit-exact; quaternions through `slerpFlat`'s acos/sin branch and the orbit's sin/cos within 1e-15 (host libm vs V8 fdlibm), rows within 1 f32 ulp. The template parts' `rotation` (Euler) is no longer re-derived and their mixers no longer tick (nothing reads either, §6). |
| `?rustAnimSceneryGate=on` | off | The rAF loop's per-instance gate without the per-instance pointer chase (JS-only, the part of lane D that reads the three.js graph and cannot move): the anchor's parent mirrored on the instance from its own `added` / `removed` events, the parent chain walked once per distinct parent per frame, the landblock id cached at registration (a per-landblock record stamped per frame), and parked + detached + collapsed instances skipped from a flat array until an `added` event or their landblock leaves the park. | Yes: same reclaims, collapses, restores, slots, rows, counters, frame by frame (§5). Relies on two grep-verified invariants (§5). |
| `?rustTerrainFx=on` | off | The scatter pool's per-frame re-scatter PLAN in Rust (`SceneScatterPlanner`): the edge queue, the round-robin scan and its per-instance TEST, the budgets, the cursor — every terrain-VFX pool that opts in (rock pebbles + grit, sand streamers, snow spindrift, dirt haze). The pool's own `scatterInstance` still places every instance the planner names, in its order. | Yes: integer + f64 arithmetic only, no trig. Every scatter, its order, every buffer write, the upload ranges, the oracle call sequence and the pool stats are identical (§5). |

Files: `crates/holtburger-scene/src/{anim_scenery.rs,terrain_fx.rs}` (kernels),
`crates/holtburger-scene/tests/{anim_scenery_parity.rs,terrain_fx_parity.rs}` + `tests/fixtures/{anim_scenery,terrain_fx}.json`,
`apps/holtburger-web/src/scene_wasm/{anim_scenery.rs,terrain_fx.rs}` (`SceneAnimScenery`, `SceneScatterPlanner`),
`apps/holtburger-web/scene3d/rust/{anim_scenery.js,terrain_fx.js}` (bridges),
`scene3d/animated_scenery.js` (kernel dispatch + the gate), `scene3d/anim_scenery_gpu.js` (row mirror + `copyPoseRowFrom`),
`scene3d/terrain_scatter.js` (the `opts.scanPlanner` hook: +66 lines, one changed — `stats().edgePending` reads the planner's queue while one runs; every export unchanged, still imports nothing and reads no flag),
`scene3d/terrain_{rock,sand,snow,dirt}.js` (one `scanPlanner: rustScatterPlanner()` per pool),
`tools/rust_parity/{gen_anim_scenery.mjs,gen_terrain_fx.mjs,model_terrain_fx.mjs}`,
`tests/{rust_anim_scenery_parity.test.mjs,rust_terrain_fx_parity.test.mjs}`.

Diag: `window.__animSceneryDiag()` gains `rustAnimScenery` / `gate` blocks when those flags are on;
`window.__rustAnimScenery.stats()`, `window.__rustTerrainFx.stats()` once a kernel exists; a pool's
`stats().scanPlanner` (stops, desync, queued lines) while it runs on the planner.

## 2. Where the time goes, and the cut [M]

1070 profiles 2026-10-23 (`/mnt/wbterminal1/tmp/claude-scratch/perf/gg-grass-gpu-2026-10-23/on-r{1,2,3}-run.cpuprofile`),
normalised per displayed frame. ⚠ Each cpuprofile covers ~9.4 s of its 20 s run: frames = profile seconds × fps
(407 / 445 / 416), not the run's frame count (860 / 957 / 891), or every number halves.

**Animated scenery `loop`: 0.21–0.25 ms/frame.**

| Part | ms/frame | Kind | Moved? |
|---|---|---|---|
| per-instance gate (`loop` self: `_isOrphaned`, `_isParkedLbMemo`, `_anchorVisible` inlined), ~3,400 instances, most parked | 0.11–0.14 | three.js graph READS (pointer chase) | No — cannot leave JS (it reads `node.parent`, `node.visible`, `userData`). Made cheap instead: `?rustAnimSceneryGate` |
| `syncAnimInstMaterials` (variant ↔ member material mirror) | 0.037–0.042 | object property writes | No (property polling; lane F's material-variant area) |
| three `AnimationMixer` (`update`/`_update`/`evaluate`/`slerpFlat`/`apply`) | 0.02–0.04 | numeric (+ binding writes) | **Yes** — `?rustAnimScenery` |
| `_updateGpuPoseRows` + `_advanceOrbit` | 0.008–0.011 | numeric | **Yes** — `?rustAnimScenery` |
| rAF + `_nowMs` | 0.01–0.016 | host | No |

`_writeInstancedPose` (the per-slot `N × P × U` product, the 1.3 ms of 2026-10-17) does not run on the default
path at all: `?animSceneryGpu` (default on) poses every bucket in the vertex shader. It stays JS under the flag
— it reads the written-back template parts, so `?animSceneryGpu=off` is exact too (§4). Moving it would have needed
a deferred, re-ordered slot write (reclaim swap-moves read slots mid-loop) for a path nobody runs.

**Terrain VFX `terrainVfxTick`: 0.35–0.39 ms/frame.**

| Part | ms/frame | Kind | Moved? |
|---|---|---|---|
| `terrain_scatter.js` pool `update` (all pools, incl.), of which the scan's self time ~0.115 | 0.14–0.18 | numeric over typed arrays (the per-instance TEST) + per-rescatter oracle / fill | **The scan: yes** — `?rustTerrainFx`. The re-scatters (oracle sample, gates, the consumer's fill: ~0.045) stay JS. |
| rock pebble provider (= its pool) / grit provider | 0.12–0.15 / 0.03–0.04 | the pool above; the grit travel integration is O(1) | (pool) — the "CPU-integrated grit travel" is three scalar ops a frame, not a loop |
| `trail_map.js update` | 0.11–0.13 | ~85 % a GL pass (`renderer.render` of one quad through the depth-band / batched-runs / async-link hooks) | No (GL). Finding: one quad pays the full `render()` + hook chain, ~0.1 ms; a direct draw would recover most of it (not a Rust move; depth_band_sort.js is not mine). |
| `vfx/fx_fields.js update` | 0.02–0.05 | O(1) uniforms; `nightFactorFromAuthoredPitch` (night_ramp.js `_params`/`_search`) is the biggest piece; an 81-sample oracle grid every 0.5 s / 2 m | No — nothing per particle on the CPU (the fields are placed in the vertex shader). Finding: night_ramp's per-call search could be cached per frame (not mine). |
| sand / snow / dirt | — (not on the route) | each = one scatter pool + O(1) uniforms; dirt also counts live puffs over its ring (diag only) | via the pool (`?rustTerrainFx`); the puff count stays (µs) |

Laptop node measurements (same engine as Chrome, not the 1070 CPU; min of N rounds) [M]:

| Workload | flag off | flag on |
|---|---|---|
| anim-scenery rAF loop, 3,440 instances (3,360 in parked landblocks), GPU rows, 4 DIDs — `?rustAnimSceneryGate` | 323–373 µs/frame | **66 µs/frame** (the first, instance-field-only version of the memo: 120 µs) |
| ultra pebble pool (18,225 instances, 72 m), standing — the scan alone | 60 µs/frame | Rust planner, not measurable before the wasm build; [D] ~2-5 µs + a call |
| same, walking 0.12 m/frame / running 0.25 m/frame | 124 / 132 µs/frame | scan moved, ~80-150 re-scatters a frame stay JS |
| `_advanceDidGroups` (4 DIDs, 8 rows) in the loop above | ~10 µs/frame | one wasm call + write-back + row copy (needs the build) |

Expected on the 1070 [D]: gate ~−0.1 ms/frame (most of the 0.11–0.14 body), template pose ~−0.03 ms, pool scan
~−0.1 ms at ultra on rock terrain while running (pebbles + grit; similar on sand / snow / dirt terrain). Total
~0.2–0.25 ms/frame of the 20.6 ms main-thread frame. Owed: the 1070 A/B per flag.

## 3. `?rustAnimScenery` — data flow

Registration: `getOrCreateDidGroup` / `getOrCreateWindGroup` build their clip + mixer exactly as before, then
`rustAnimRegisterGroup(group, key, frames, numParts, numFrames, fps, closedLoop)` hands the kernel the same inputs
`buildSceneryAnimationClip` got (key = the numeric animation DID, 0 for a wind group) and the parsed omega
(`parseSetOmega`'s unit axis + rad — JS computes them, `Math.hypot` included). `poseRowFor` (anim_scenery_gpu.js)
mirrors every row it allocates (`rustAnimRegisterRow`, in order; any gap turns the kernel's rows off for the
session — rows are then written by the JS code from the written-back template parts, still exact).
`_disposeDidGroup` / `disposeAnimatedScenery` / `disposeAnimSceneryGpu` unregister / clear.

Concurrent creation (review fix, 2026-10-26): two `getOrCreateDidGroup` calls for one DID can both miss the map
while `fetchAnimation` is in flight (two bakes awaiting one setup's shared geometry; the unawaited cells.js
attach). Both build a group; the map keeps the second (flag off: the first is garbage). With the flag on the
second is registered, then the first is unregistered (`prev._rust`), so the kernel holds exactly the map's groups
— before the fix the dropped group stayed in the kernel for the session, was stepped every frame, and rows
registered later bound to it (wrong poses). Kernel side, rows now bind to the most recently REGISTERED group of
their key (what the map holds) and an unregistered group's rows are left unbound, never handed to another group
of the key (`AnimScenery::register_row` / `unregister_group`; unit test `rows_follow_the_latest_group_of_a_key`).

Per frame (`_advanceDidGroups`, used by the rAF loop and `tickAnimatedScenery`):
1. `SceneAnimScenery.advance(dt, omegaHz)` — every group's mixer step + orbit, then every row;
2. per group: kernel-held → `rustAnimWriteBack` (template parts, `orbitQ`, `orbitAngle`); otherwise its mixer +
   `_advanceOrbit` as before (a group the kernel refused);
3. `_updateGpuPoseRows(true)`: a kernel-held group's row is copied (`copyPoseRowFrom`) when the kernel wrote it —
   the kernel writes a row exactly when the JS loop would (group present, part in range); other rows run the JS code;
4. everything after (instances, `_writeInstancedPose`, legacy per-mesh copies, flushes) is unchanged and reads the
   written-back template.

Buffers: parts (f64, 7 per part at the group's offset), group (f64, 7 per slot: orbit xyzw, angle, mixer time,
action time), rows (f32, 32 per row), rows-written (u8). Pointers only move on registration (re-read then); views
re-check memory growth each frame. A kernel failure mid-session hands every group back to its mixer with the
mixer and action clocks of the last successful advance (`rustAnimFallback`): `rustAnimWriteBack` snapshots both
clocks into `group._rust` while the view is fresh, so nothing reads wasm memory after a failure (a grown memory
detaches the view; a registration can move the group buffer). The interpolant index is only a seek hint; the
mixer's PropertyMixer accus are stale (its creation's pre-play pose), so the one its next update compares against
is poisoned with NaN — that update writes every part, exactly what an always-running mixer leaves. Pinned by the
R / F2 / F3 arms of tests/rust_anim_scenery_parity.test.mjs (Object.is vs flag off from the failure on).

## 4. `?rustTerrainFx` — the planner protocol

Hook (terrain_scatter.js, `opts.scanPlanner`, the consumer calls `rustScatterPlanner()` — the pool itself still
reads no flag and imports nothing, plan §2.4 / its own suite): in `update()`, after the teleport check and the
re-centre, `planner.plan(gxMin, gyMin, cx, cy, scatterInstance, resolvedFlags, outFlags)` replaces the edge drain +
round-robin block; the pool then updates `state.*` from the returned counts and flushes its ranges as before.
`rescatterAll` → `planner.sync(cellX, cellY, resolvedFlags, outFlags, gxMin, gyMin, 0)` (teleport / first frame
only); `invalidate` → `planner.invalidate()`; `invalidateRegion` → `planner.syncResolved(resolvedFlags)`.

The kernel mirrors the four arrays the TEST reads and replays `scatterInstance`'s deterministic part (the cell,
the jitter hash, the disc test → `outFlags`, and `resolvedFlags = 1` when out of the disc). The one thing it
cannot know is whether the ORACLE resolved an in-disc instance (`resolvedFlags` 0 = unbaked landblock); a later
TEST of that instance in the same frame (an x-line crossing a y-line, the scan crossing a freshly drained line)
needs it. The kernel marks it PENDING and, when about to re-test it, STOPS: JS scatters the batch so far
(in order), writes `resolvedFlags | outFlags << 1` per entry into the outcome buffer, calls `resume(n)`, and the
kernel continues exactly where it stopped. Calls per pool per frame: 1 + batches — 1 standing still, ≤ 2 in every
recorded walk (fixture: max 1 stop / frame). `outFlags` disagreements between kernel and JS are counted (`desync`,
always 0 in every test) and JS's value wins.

Fail-soft: a planner that throws turns itself off; the pool continues with its own loops from the planner's cursor
(its queued edge lines are lost — the round-robin re-finds those instances, i.e. some leading-edge pop-in on that
one failure). A missing / stale pkg: `attach` returns null and the pool runs its loops for its whole life.

## 5. Exactness, and how it is pinned

- **Kernels vs the real JS (cargo)** — status 2026-10-26 after the first build: everything compiled with no
  warnings; terrain_fx_parity 2/2; anim_scenery_parity's module test first failed on a TEST bug (fixed): the
  fixture snapshots a frame after the module loop's reclaim, and the groups that reclaim disposed are unregistered
  by the "afterFrame" events recorded right after it (the JS advanced them and wrote their rows in that frame
  first), so the live-group set is now checked once those events are applied, not at the frame event. The
  compiled kernel already matched through the bridge (node Part 2, 21/21 and 47/47).
  `tests/anim_scenery_parity.rs` replays `gen_anim_scenery.mjs` — 8 clip cases
  (open / closed loops, 0 / 12.5 / 17 / 24 / 30 fps, a plain-Array source, dt sequences with 0, the 0.1 clamp and
  negative steps) and the module scenario (4 DIDs incl. the real client_portal.dat seagull clip + omega, rows with
  and without the unbake post, a group disposed and re-created, a parked landblock, omega Hz changes). Exact:
  times, clocks, orbit angles, positions, trig-free quaternions; 1e-15: slerp / orbit quaternions; ≤ 1 f32 ulp:
  rows. `tests/terrain_fx_parity.rs` replays `gen_terrain_fx.mjs` — 5 pools (disc / square, 400–2,500 instances,
  default and tiny budgets, a 110-frame edge backlog with re-enqueued lines) on a stub oracle with late-baking
  landblocks and a pointwise hole, walking / running / zigzagging / a teleport / `invalidate()`: every scatter in
  order, written / scanned / cursor / edge counts, queued lines, zero desyncs. The fixture's scatter log is taken
  from the REAL pool by recording proxies on its typed arrays (counts equal the pool's own `rescatters`).
- **Bridges + hooks (node, Part 1, no wasm)**: JS models of both kernels (anim: in the test; terrain:
  `tools/rust_parity/model_terrain_fx.mjs`, line-for-line transcriptions) replay the fixtures BIT-EXACTLY (on V8
  even the trig matches), then drive the real bridges on a fake wasm memory that grows: flag-off vs flag-on,
  every pose-table row, every bucket instanceMatrix / count / visible, every anchor, every template part / orbit
  (anim), every attribute array, the instanceMatrix, upload ranges, per-instance flags / cells, the oracle call
  sequence and pool stats (terrain), plus the real rock fields (pebbles + grit: their fill, gates, light, grit
  travel) — Object.is-identical, frame by frame. Mutation checks: dropping the gate's `removed` mirror, its
  `added` full-pass trigger, or the pool's `invalidate()` mirror each fails the tests.
- **Part 2 (after the build)**: the same comparisons against the compiled classes (anim with the 1-ulp / 1e-15
  tolerances, terrain exact).
- **The gate's invariants** (grep-verified 2026-10-26; a change to either breaks the gate's exactness, not the
  flag-off path): (1) every parent change of an anchor dispatches `added` / `removed` — three's add / remove /
  attach / removeFromParent / clear and scene3d/bulk_child_remove.js (the LRU's park / evict) do; the only direct
  `.parent =` writes in scene3d are that helper's (evented) and an unrelated record field; (2) an anchor's
  `userData.landblockId` is written once at build and never re-assigned.

## 6. Left on the JS path, and why

- The per-instance gate's graph reads, `syncAnimInstMaterials`, the rAF clock: object reads / writes (§2).
- `_writeInstancedPose` (CPU slots, `?animSceneryGpu=off` only) and the legacy per-mesh copies: they consume the
  written-back template; moving them would need re-ordered slot writes for a non-default path.
- The scatter pool's `scatterInstance` (oracle sample, family / road / exclude gates, the consumer's `accept` /
  `fill`, attribute + matrix writes, upload ranges): it needs the terrain oracle's landblock caches and each
  family's fill in Rust — a port of terrain_oracle.js plus five fills, with landblock data mirrored into wasm.
  Not done; the scan was the bulk of the pool's self time.
- trail_map (GL pass), fx_fields (O(1) + night ramp), dust devils (ParticleManager), dirt puff live count.
- Under `?rustAnimScenery` the template parts' Euler `rotation` is not re-derived and the mixers' `time` stays 0
  (diag reads the kernel's): audit — the template Group is never added to a scene; its parts are read only by
  `_partMatsFor` (position + quaternion) and the legacy copy (`quaternion.copy`, raw fields).
- terrain_grass.js (CPU placement path) and ground_fog.js also use the pool; they are not mine and do not opt in
  yet. Both are VALIDATED exact on the planner (patched copies, model kernel: grass one field and three LOD rings
  with off-road toggles and a region invalidation, fog — 150 frames Object.is-identical, 0 desyncs); the `Q`
  section of tests/rust_terrain_fx_parity.test.mjs compares them in Part 1 and Part 2 as soon as they opt in
  (SKIP lines until then; `HB_GRASS_MODULE` / `HB_FOG_MODULE` point it at a patched copy). Grass: worth it only on
  the `?terrainGrassGpu=off` CPU escape (GPU placement is the default since 2026-10-23). Fog: exact but no gain —
  ~25 cards with sliceSize = scanBudget = count, a wasm call costs about what its JS scan does.

## 7. Tests and how to run them

```
node tests/rust_anim_scenery_parity.test.mjs    # Part 1: 24 checks; Part 2 (compiled kernel): 17 more
node tests/rust_terrain_fx_parity.test.mjs      # Part 1: 31 checks (+5 Q once grass / fog opt in); Part 2 after the build
node tools/rust_parity/gen_anim_scenery.mjs     # regenerate fixtures (the tests flag a stale one)
node tools/rust_parity/gen_terrain_fx.mjs
cargo test -p holtburger-scene                  # anim_scenery_parity, terrain_fx_parity + unit tests (orchestrator)
```
Flag-off suites run green after the change: test_animated_scenery(_park), tests/anim_scenery_{gpu,bucket_vis,
unbake}, tests/animated_scenery_omega, test_terrain_{scatter,rock,sand,snow,dirt,vfx_lifecycle,vfx_promotion},
and every other suite importing a touched file (grass, ground fog, volcano, ice, sparkle, shaders, film, look
pass, statics single instance, fixed-grid park, …).

## 8. Risks / what to check first

1. **Rust compiles** — written without a compiler: `seek` (labeled blocks with a valued `'linear_scan` block),
   the `let … else` forms, the glue's wasm-bindgen signatures (`&[f32]`, `&[i32]`, `&[u8]`, `&[f64]`).
2. **Part 2 of both node tests** — the first run of the real classes through the bridges (pointer getters,
   views over the batch / outcome / stats buffers, memory growth).
3. **`?rustAnimSceneryGate` invariants (§5)** — if anything starts re-parenting anchors without events or re-tags
   `userData.landblockId`, the gate goes stale (the tests catch the former; the latter is documented, not
   detected).
4. **Planner stops** — 1 + batches calls per pool per frame; if a future pool sees many stops per frame (very
   large edge budgets crossing each other), it stays exact but pays more calls (`stats().scanPlanner.stops`).
5. **Fixture freshness** — both node tests regenerate their fixture in memory and fail on drift; rerun the
   generators after any change to animated_scenery.js / anim_scenery_gpu.js / terrain_scatter.js semantics.
