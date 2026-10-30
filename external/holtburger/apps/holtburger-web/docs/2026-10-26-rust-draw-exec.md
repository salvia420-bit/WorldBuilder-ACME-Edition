# Lane X — the stage-3 draw executor `?drawExec` (S3.1), sentinel runs `?drawExecRuns` (S3.2, deleted 2026-10-30: §10) and entity parts `?drawExecRigs` (S3.6) (2026-10-26)

Part of the Rust scene core effort: [2026-10-26-rust-scene-core.md](2026-10-26-rust-scene-core.md) (plan, contract,
lane table). Design: [2026-10-26-rust-draw-list-design.md](2026-10-26-rust-draw-list-design.md) (R3; §5 the design,
§7.2-7.3 validation, §8 staged plan). Evidence tags as there: **[M]** measured, **[M-node]** measured in node on this
laptop (i5-6300U, shared with other lanes) over the fake WebGL2, **[D]** derived, **[C]** code read.

Nothing here ran in a browser, under cargo or on the 1070 (laptop rule). The SwiftShader pixel smoke is written for the
orchestrator (§6). §9 is lane X2's follow-up (the two hook-driven divergences fixed exactly, coverage, the fast path).
§10 is round 3 R3-2 (2026-10-30): the `?drawExecRuns` code, its seams and its suite / smoke arms deleted.

## 1. What shipped

| Flag | Default | What it does | Exact? |
|---|---|---|---|
| `?drawExec` | **ON** since 2026-10-26 (orchestrator; `=off` escape) | `scene3d/draw_exec.js`, the OUTERMOST `renderBufferDirect` wrapper. The first draw of an eligible static (object, material, group) goes through the untouched chain and is RECORDED (three's program and uniform objects, the VAO three bound, the index type, the geometry as the program's attributes by identity + index version + drawRange, the material fields three re-reads per draw, async_link's stamp combo). Later draws validate the record with property reads and take: CONTINUATION (same program, material, camera, render call as the draw before: the executor issues exactly what three's setProgram would — the batching texture binds through three's own `textures.setTexture2D`, receiveShadow, the matrix setters, `state.setMaterial` unless provably a no-op — then the VAO and the draw), SWITCH (three's own renderBufferDirect with a degenerate group runs setProgram + setMaterial and returns before its VAO setup; the executor then binds and draws, or lets three draw and re-records if the program moved), or FULL (the chain). It stands in for batched_runs (its own `batchedRunsBeforeDraw`), skip_empty_multidraw (its own `skipEmptyMultiDrawTake`) and async_link_guard (its stamp test) on the draws it executes. | Yes: the full GL call stream (every call, with arguments, as it reaches the driver) is identical to the flag-off arm's, frame by frame, in 16 scenarios (§3), with identical `renderer.info`, `__batchedRuns.frame()` totals and batched_runs / skip_empty / bmIndirectPerCamera stats. |
| ~~`?drawExecRuns=on`~~ | **deleted 2026-10-30** (round 3 R3-2, §10); was off | S3.2 (history): an outermost `list.sort` hook collapses each run of ≥ 2 consecutive opaque items the executor owns into ONE sentinel render item; the executor does every item's renderObjects + renderObject steps itself, in order (layer test, override material, hooks unless they are three's own empty prototype functions, matrices, the two-pass branch, the draw). Never while a wrapper sits over the executor, for another scene's list, or with transmissive items. **No measurable gain in node** (§4); never default-on, deleted in R3-2. | Was: yes, same proof (a third arm in every scenario). |
| `?drawExecRigs` (needs `?drawExec`) | **ON** since 2026-10-26 (orchestrator; `=off` escape) | S3.6 (R3 §8): worldRoot's `entities` group is an owned root too, so rigid entity parts are executed (SkinnedMesh / InstancedMesh stay refused by type). Nothing in the executor depends on a draw being static: matrices go through three's setters on every draw, and churn cool-downs absorb fades. Not in the brief's S3.1 scope — added because entity parts are the largest pass-through population (~450 draws at Holtburg, R3 §6 option I) and the pass-through costs ~0.2 µs each (§4). | Yes, same proof (the rigs arm of every scenario: the shipped default; until R3-2 it ran with runs on). |

Live seams: `window.__drawExec` — `.off` (A/B, live), `.stats` (draws, fast, stateOnly, full,
passThrough, empty, recorded, progChanged, smSkips, vaoBinds / vaoSuppressed / vaoFixes /
vaoFixLate (a hand-over bind the setup hook missed, §3.1: must stay 0), restores, resets, errors, `invalid` by reason, `refused` by reason, `chain`), `.verify(frames)` (for N rAF frames every
executed draw also checks renderer.properties / program / uniforms / the VAO model and GL's own `CURRENT_PROGRAM` and
`VERTEX_ARRAY_BINDING`; resolves `{checks, fails}` — sync GL queries, diag only).

Eligibility shipped (memoized per object; per-draw conditions re-checked):
- main scene only (shadow-map draws pass `scene === null`; other scenes — sky, late FX, post quads — pass through);
- `Mesh` / `BatchedMesh` under worldRoot's `terrain`, `buildings`, `statics`, `cells` groups (resolved by name from the
  main scene; nothing in index.js passes them, so the install line stays one line);
- material: built-in `Mesh*Material` or `ShaderMaterial` / `RawShaderMaterial`.

Refused, with the reason it is refused:

| Refusal | Why |
|---|---|
| `notStatic` (entities unless `?drawExecRigs`, worldRoot's own children: grass / scatter / decals, sky, anything outside the roots) | R3 §5.3: static kinds only for S3.1. Exactness does not depend on it (every input is validated per draw). |
| `instanced`, `skinned`, Points / Lines / Sprites (`notMesh`) | Instance attributes / bones / other draw modes: three's per-object binding states and uniforms the executor does not model. |
| `morph`, `instancedGeometry` | Morph textures and instance counts are set inside setProgram / the draw per object. |
| `wireframe` | three swaps the index for a generated wireframe attribute inside the draw. |
| `uniformsGroups` (populated) | UBO update + bind per draw inside setProgram. An empty array (every ShaderMaterial has one) is fine. |
| `clipping` (material planes), `rendererClipping` (global planes / local clipping) | Clipping state is per material × camera inside setProgram. |
| `transmission`, `twoPass` | The transmission pass / three's two-pass translucency bump `material.version` every draw. |
| `noAsyncLink` (`userData.__noAsyncLink`: the occlusion proxies) | Their hooks bracket a query around the real draw; nothing to gain. |
| `churn` (cool-down, 240 draws of the record) | A record whose material version or program moves on every draw (two-pass, a material drawn into targets of different output colour spaces) would cost a re-record or a second setProgram per draw. |
| per draw: `uniformsNeedUpdate`, `asyncLinkStamp` | The draw goes through the chain (three re-uploads / async_link decides); the record is kept. |
| `tooManyMaterials` | > 8 (material, group) records on one object. |
| record refusals: `drawShape`, `noMultiDraw`, `samplerSetter`, `noBatchingSamplers`, `noColorSampler`, `indexType`, `drawArgs`, `programMismatch`, `noVao` | Self-checks at record time: the draw three issued must be the one the executor would issue (one multi-draw / one draw with the args it computes, three's own `setValueT1` on the batching samplers, a known index type). Anything else stays on the chain. |

## 2. Files

- `scene3d/draw_exec.js` (new): the executor, S3.2 (deleted 2026-10-30, §10), S3.6, the VAO / state coherence hooks, `window.__drawExec`.
- `scene3d/batched_runs.js`: the wrapper's body is now the exported `batchedRunsBeforeDraw(renderer, object)` (L1
  observe + run layout + frame count, returns the run state) and `batchedRunsCall(fn, this, st, pending, ...)` (the
  `_indirectTexture` swap + `_pending` around a call); the wrapper is built on both, so behaviour is shared. Wrapper
  diet (exact, helps the stock path too): `_frameKey` keeps a one-entry (renderer, render.frame) cache in front of its
  WeakMap; `_extensionFor` caches its answer per `renderer.extensions` object (a restore brings a new one); one
  `_eligible` lookup per draw instead of two. Chain tags `__hbRbdTag = "batchedRuns"` / `__hbRbdInner`. Test seam
  `__resetBatchedRunsFrameForTest()`.
- `scene3d/skip_empty_multidraw.js`: chain tags; `skipEmptyMultiDrawTake(object)` (the wrapper's decision + counter).
- `scene3d/async_link_guard.js`: chain tags; `api.comboEpoch` getter (the restore epoch folded into the stamp).
- `scene3d/index.js`: two lines — the import, and `try { installDrawExec(renderer, () => scene); } catch (_) {}` right
  after `installBatchedRuns(renderer)`.
- `tests/draw_exec.test.mjs` (new): the identity suite + `--bench` + `--bench-scenes` (§3, §4).
- `tests/helpers/fake_webgl2.mjs` (extended, existing behaviour unchanged): `opts.onCall(name, args)` — called at the
  bottom of every context and extension function (below every wrapper installed later); `opts.clipControl` —
  `EXT_clip_control` + `getParameter(DEPTH_FUNC)`; `__fake.plain()` — the context as a plain object (names
  materialised on first access) for timing; `depthFunc` is now an impl method (same counter as the lazy no-op).
- `harness/glsl_smoke/draw_exec_smoke.mjs` + `draw_exec_page.html` (new): the SwiftShader pixel smoke (§6).

## 3. The exactness proof (node)

`tests/draw_exec.test.mjs` runs three r184's real WebGLRenderer over the fake WebGL2 with every production patch in
index.js order: reversed-Z (fake `EXT_clip_control`; `installReversedZ`), `installLightUboChunks` +
`installUniformBindPatch` (texUnitPin, lightUploadOnce, lightUbo), `installDrawSortProgram` + a punch phase,
`installDepthBandSort` (one scenario at 1 band/octave), the BatchedMesh colorTexture fix, `installAsyncLinkGuard`,
`installBatchedIndirectPerCamera`, `installSkipEmptyMultiDraw`, `installBatchedRunsChunks` + `installBatchedRuns` (+ L1,
sorted runs) — then the executor. Four arms per scenario: stock, `?drawExec`, `?drawExec` + `?drawExecRuns`,
`?drawExec` + `?drawExecRuns` + `?drawExecRigs`. (Since R3-2, §10: three — stock, `?drawExec`, and the shipped default
`?drawExec` + `?drawExecRigs`.)

The world: pools on the early-out with runs (some with colours), culled unsorted buckets with runs, sorted translucent
buckets with consecutive runs, unmarked atlas buckets, building batches + meshes, plain statics on shared materials
(mirrored ones, a multi-material one, ones with state-changing hooks, a ShaderMaterial on a custom attribute), LOD
levels, a many-sampler terrain ShaderMaterial +
far-terrain patches, layer-1 cell statics and a cell pool; interleaved: dynamic entities, an InstancedMesh, a
transparent DoubleSide two-pass mesh, an occlusion-style proxy, a sky outside the roots, meshes sharing geometry and
material with the statics (VAO hand-overs), a nested render in a hook.

Scenarios (each 6–16 frames, camera moving every frame): baseline; events (resetState, pool add/delete, material
needsUpdate, map version bump, attribute replaced, drawRange, receiveShadow, matrix moved, light added → program change,
uniformsNeedUpdate, `__drawExec.off` toggled); indoor split (two render() per frame, layer masks, depth clear) into an
MSAA target; shadows (shadow pass + shadow samplers ahead of the batching units); nested render + depth bands; context
loss + restore; in-place attribute swap + index update + BatchedMesh addGeometry + an async-link compile in flight; one
material over three render() per frame (two targets + canvas); ArrayCamera (sub-cameras with different layers inside one
render()); ArrayCamera over one material; `scene.overrideMaterial` (the `?portalStencil` pattern); a transmissive item;
a diag wrapper over the executor; shared geometry + an emptied pool; zero-instance draws three sets up between executed
statics (an InstancedMesh with count 0, an InstancedBufferGeometry with instanceCount 0, an emptied pool with
skip_empty absent), and the same world with skip_empty installed (§3.1).

Compared, frame by frame: every GL call with its arguments (GL objects by creation id, typed arrays by content,
multi-draw arrays by their live window); `renderer.info.render` and `batchedRunsFrameTotals()` after every render();
batched_runs / skip_empty / bmIndirectPerCamera stat deltas; sampler-unit conflicts and UBO backing (the fake's checks).
Plus coverage: the executor must have executed (fast + state-only share), formed runs, and the VAO hand-over machinery
must have been exercised, and every hand-over bind must have been issued at three's setup (`vaoFixLate` 0 in every
arm). **283 checks, all pass, ~20 s** [M-node].

The suite has teeth — mutation testing (scratch mutants of draw_exec.js, `DX_MODULE=<file>`): 31 single-point breaks
(no VAO fix, no bind suppression, no setMaterial, wrong front face, no receiveShadow, no batched_runs part, no
model-view upload, no custom-attribute / named-attribute / index-version / camera / serial / async-stamp / program
post-check, no colours-texture bind, no restore hook, each of the three setMaterial-skip guards; eight S3.2 breaks:
no layer test, no onBeforeRender, no onAfterRender, no override material, no material onBeforeRender, no matrices,
ignoring an outer wrapper, ignoring transmissive items; and four for the setup hook of §3.1: no bind at setup, no
adoption of new programs, no re-adoption after a context restore, no fallback trigger). **29 of 31 fail the suite.**
Two survive. One drops the "no runs with transmissive items" guard: the suite's transmission scenario shows collapsing
there is exact too (three's transmission pass renders the opaque list a second time and the sentinel replays the same
steps); the guard is kept as the design's conservative choice. The other drops the fallback trigger, as expected: the
setup hook issues every hand-over bind in the suite (`vaoFixLate` 0), so the fallback only matters for a program the
hook never adopted, which the smoke checks in a real browser.

Two test-determinism lessons, both handled: async_link's off-frame compile runs on timers (drain at 0 ms, readiness
poll 10 ms after the compile), so a fixed inter-frame sleep lets a slow compile (a loaded laptop) defer draws in one arm
only — the suite and the smoke now wait until async_link has nothing queued or in flight; batched_runs keeps its
per-frame totals and its L1 audit tick module-wide — reset per arm.

Regression (targeted, one at a time): `tests/batched_runs.test.mjs` (69), `batched_runs_sorted` (58),
`batched_runs_stable` (42), `static_early_out` (85), `pool_runs` (138), `atlas_geom_dedup` (114), `structure_p0_probe`
(179), `test_skip_empty_multidraw.mjs` (11), `test_async_link_guard.mjs` (36), `async_link_key_sig` (44),
`uniform_bind_patch` (56), `webgl_restore_render_patches` (31) and every other fake_webgl2 user (building_mat_batch,
clouds_boot_order, csm_receiver_worldpos, drone_props, fade_alpha_state, hd_swap_no_bump, ibl_stable_env,
interior_shadow_raster_scope, late_fx_warm, paperdoll_persist_viewport, shadow_caster_list_restore,
sway_shadow_depth_variants, terrain_batch_no_drawid, tunnel_world_warm, vertex_pull_spike, test_stat_batch_value_key),
plus index.js-reading suites (depth_band_sort, reversed_z, canvas_depth, test_init3d_idempotency_guard): all pass.

### 3.1 Review follow-up: hand-overs to draws that issue no GL call after three's setup (2026-10-26)

Found in integration review (repro `review3/r1_zero_instances.mjs`). three is handed a draw while its believed VAO T
differs from the bound G, finds its binding state already current (T), binds nothing — and the draw then returns before
any GL call: an InstancedMesh with `count` 0 (animated-scenery buckets), an InstancedBufferGeometry with `instanceCount`
0 (the grass ring), a BatchedMesh with `_multiDrawCount` 0 under `?skipEmptyMultiDraw=off` (a pass-through one, or an
executed one through the executor's zero-count path). The old fix waited for the first VAO-dependent GL call, which never came. Stock's setup had bound the
object's VAO at that point, so the flag-on stream lacked one `bindVertexArray` and the next bind decisions differed. No
pixel effect (nothing drew; the next real draw binds its own VAO), but not the same stream, and the bar is the stream.

Fix (exact): the bind is now issued where stock issues it. `WebGLBindingStates.setup` makes its bind decision and then,
before any other GL call, calls `program.getAttributes()` (needsUpdate). The executor wraps `getAttributes` on every
WebGLProgram as three creates it (the push onto the list behind `renderer.info.programs`, re-adopted after a context
restore); a hand-over still armed there binds T. That covers every setup, with or without GL calls after it. The old
triggers stay as a fallback and count `stats.vaoFixLate`: 0 in every scenario and arm of the suite, and the smoke now
requires 0 (a non-zero count means a program escaped the hook). The six premises (setup → needsUpdate →
`getAttributes` with nothing in between, the program list, `getAttributes` an own property, `getUniforms` making the
first use in setProgram) are exported as `THREE_SETUP_PREMISES` and checked against three.module.js by the suite.

Not taken: the review's alternative, binding at the END of the hand-over when three "reached its setup", which it
decides by replicating renderBufferDirect's drawRange / group / position / wireframe-index arithmetic (including the
private wireframe index count). It is exact today, but it copies three internals that can drift without any premise
noticing (a drift binds where stock does not, or skips a bind stock issues), and it binds after the draw rather than
at setup, which is the same stream only while three issues nothing between its setup and its return. The hook needs
no arithmetic and binds where stock binds, including when the draw throws.

Evidence [M-node]: two new scenarios (the zero world: six statics on two materials, an InstancedMesh and an
InstancedBufferGeometry mesh under worldRoot between them in the sort, an executed pool; frames take turns so each kind
is, for three frames, the only draw three sets up), with skip_empty absent and installed. The pre-fix executor fails
both (first diff frame 4, one missing `bindVertexArray`), and each kind fails on its own too (scratch plans with one
kind: InstancedMesh frame 4, ring frame 3, pool frame 4). The fixed executor passes all of them; the hand-over fixes
counted there are 6 and 4, the number the schedule predicts (two per kind; the pool's are skipped when skip_empty is
installed).

Cost [M-node]: below the noise floor. A scratch bench (300 draws a frame; stock, the pre-fix executor and the fixed one
in one process, arm order rotated per rep, best p50 of 15 reps, two processes with opposite scene orders): fixed −
pre-fix = −0.014 / +0.034 µs per draw on an all-pass-through scene, −0.044 / +0.074 µs per draw on a mixed scene
(hand-overs on every other draw). One earlier run without the rotation showed +0.34 µs on the first scene it measured;
it did not reproduce with the rotation (an arm-order artefact). The hook is one extra call per `getAttributes` (1–3 per
draw three sets up) and nothing on the executor's own draws.

## 4. Measurements [M-node]

(Lane X2 re-measured the fast path with a method that survives a shared laptop, and cut it: §9.4.)

Two node benches, both on a plain-object fake GL (`__fake.plain()`: no Proxy trap per GL property) with its per-call
bookkeeping replaced by no-ops for the hot uniform / texture / program calls after warm-up (as R3's prototype did), so
the numbers are three + wrappers + executor JS. The laptop is shared with other lanes: ±0.1–0.3 µs/draw run to run;
the tables are medians / bests of several runs on a quiet machine.

**Frame time on controlled scenes** (`node tests/draw_exec.test.mjs --bench-scenes`; 300 draws a scene; per-draw delta
= (arm − stock) / 300, best p50 of 9 reps; the most robust number):

| Scene | stock frame | `?drawExec` | + `?drawExecRuns` | + `?drawExecRigs` |
|---|---|---|---|---|
| pools: 300 BatchedMesh on the early-out with runs, 10 class materials (continuations) | 1.41 ms | **−1.45 µs/draw** | −1.40 | −1.16 |
| static: 300 plain meshes, 30 materials (continuations) | 0.93 ms | **−0.81** | −0.79 | −0.82 |
| switch: 300 plain meshes, a material each (every draw a switch) | 1.69 ms | +0.09 (−0.28…+0.09 over runs) | −0.11 | −0.23 |
| ineligible: 300 entity meshes (pass-throughs) | 0.94 ms | **+0.18** (+0.18…+0.27) | +0.15 | **−0.93** (executed) |
| mixed: 150 statics + 150 entities on the same materials | 0.93 ms | −0.29 | −0.25 | −0.78 |
| entities: 300 parts, matrices moving every frame | 1.06 ms | +0.19 | +0.10 | **−0.94** |

**Per kind on R3's prototype population** (`node tests/draw_exec.test.mjs --bench`: 48 pools / 8 class materials, 40
culled buckets / 12, 160 plain statics / 40, 80 entities with unique materials + the suite's kinds, ~313
renderBufferDirect calls a frame; an outer timer per call, best of 3 interleaved reps — it attributes hand-over effects
to the pass-through bucket):

| Draw kind | stock µs | `?drawExec` µs | Δ | per frame |
|---|---|---|---|---|
| BatchedMesh continuation | 6.10 | 3.74 (fast) | **−2.36** | 71 draws |
| plain continuation | 3.66 | 2.41 (fast) | **−1.25** | 78 |
| BatchedMesh switch | 14.62 | 14.57 (state-only) | −0.05 | 27 |
| plain switch | 9.48 | 9.31 (state-only) | −0.17 | 53 |
| not eligible (pass-through) | 8.71 | 9.59 | +0.88 | 81 |
| render() p50, whole frame | 3.184 ms | 3.008 ms | **−5.5 %** | (+ runs: 3.105 ms, −2.5 %) |

Reading:
- A continuation saves ~1.3–2.4 µs (R3's prototype: 0.93 µs; R3's 1070 estimate 1.6–2.9). The executor's own fast
  path costs 2.4 (plain) / 3.7 (BatchedMesh) µs here, not R3's assumed 0.6 µs: it still runs batched_runs' per-draw
  part (L1 observe, the run state, the frame count), three's `setTexture2D` per batching texture, the record validation
  (~30 property reads), the three matrix setters and the draw.
- A switch saves ~0 (−0.3…+0.1): three's setProgram (material refresh, the uniform-upload walk) is the cost, and the
  state-only call keeps all of it; what it skips (the VAO lookup, the wrappers) the validation spends. R3 said as much:
  "material switches are irreducible without snapshots" (S3.3).
- Pass-through draws pay +0.18–0.27 µs (the bare outermost-wrapper frame is 0.06–0.15 of it, ablation): keeping three's
  private trackers coherent on every three draw costs a few context writes per call.
- S3.2 sentinel runs: no gain beyond noise anywhere (as R3's prototype found: v3t ≈ v1t). Implemented, exact, off.
  Deleted on 2026-10-30 (round 3 R3-2, §10); the bench arms that measured it (`runs`, and `rigs` = runs + rigs) went
  with it.
- S3.6 (`?drawExecRigs`) is the lever: entity parts stop paying the pass-through and become continuations / switches
  (−0.9 µs/draw on parts sharing materials).
- Under `?bmColorTextureFix=off` three re-resolves the program on every BatchedMesh draw (getParameters + the cache-key
  string); the executor's continuation skips setProgram, so it saves ~15 µs per BatchedMesh draw there (pools scene
  without the fix: 5.80 → 1.30 ms) — exact, but that arm is not the default.
- Holtburg arithmetic with R3's population (§5.10: 500 static draws, half BatchedMesh, 65 % continuations, 175
  switches) and ~600 other draws of which ~450 entity parts (continuation share 0.29, R3 §3.2) [D]:
  - `?drawExec`: 162 × 1.45 + 163 × 0.81 + 175 × 0 − 600 × 0.2 ≈ **0.25 ms/frame** (R3's S3.1 estimate: 1.1 ms);
  - `+ ?drawExecRigs`: the 450 parts: 450 × (0.2 pass-through removed + 0.29 × 0.94 + 0.71 × 0.1) ≈ +0.24 ms →
    **≈ 0.5 ms/frame**;
  - `+ ?drawExecRuns`: ≈ 0.
  - All main-thread JS; CrGpuMain sees the same commands. Owed: the 1070 A/B (§7).

## 5. Requested edits (files this lane does not own)

1. `docs/url-flags.md` — three rows (next to `rustCull`):

   | `drawExec` | `on`/`1`/`true`/`yes` opts in; `off`/`0`/`false`/`no` | **OFF** (2026-10-26, lane X, stage 3 S3.1) | `scene3d/draw_exec.js` `drawExecEnabled` = `rustFlag("drawExec", false)`; live A/B `window.__drawExec.off = true`; `.stats`, `.verify(frames)` | **Static-world draws executed without three's per-draw re-derivation.** The outermost renderBufferDirect wrapper records an eligible static draw's program, uniform objects, VAO and geometry the first time, validates the record per draw, and then issues exactly what three's setProgram + setup + draw would: a continuation (same program/material/camera as the draw before) binds the batching textures, uploads receiveShadow + matrices through three's setters, setMaterial (skipped when provably a no-op), VAO, draw; a switch lets three's own renderBufferDirect do setProgram + setMaterial with a degenerate group and draws itself. Stands in for batched_runs / skip_empty_multidraw / async_link on those draws (same stats and `__batchedRuns.frame()`). Keeps three's private VAO tracker coherent (suppressed redundant binds; the hand-over bind issued at three's own setup point through a per-program `getAttributes` hook, so draws that issue no GL call after setup — zero instances, an empty multi-draw — are covered; `.stats.vaoFixLate` must stay 0). Eligible: main scene, Mesh / BatchedMesh under worldRoot's terrain/buildings/statics/cells, built-in or ShaderMaterial (no wireframe, morph, UBO groups, clipping, transmission, two-pass). EXACT: the full GL call stream identical to flag-off, frame by frame, 16 scenarios (tests/draw_exec.test.mjs, 283 checks; 29/31 mutants caught); pixel smoke harness/glsl_smoke/draw_exec_smoke.mjs. Node: continuation draws −1.3…−2.4 µs, switches ≈ 0, other draws +0.2 µs (coherence bookkeeping); ≈ 0.25 ms/frame at Holtburg by arithmetic (≈ 0.5 with `?drawExecRigs`); 1070 A/B owed. docs/2026-10-26-rust-draw-exec.md | scene3d/draw_exec.js; index.js (install after installBatchedRuns); batched_runs.js `batchedRunsBeforeDraw` |
   | `drawExecRuns` | `on`/`1`/`true`/`yes` opts in | **OFF** (2026-10-26, lane X, stage 3 S3.2) | `scene3d/draw_exec.js` `drawExecRunsEnabled` = `rustFlag("drawExecRuns", false)`; needs `?drawExec`; live `window.__drawExec.runs = true/false` | **Sentinel runs:** after three's sort, consecutive opaque items the executor owns become one render item; the executor performs each item's renderObjects/renderObject steps itself (layers, override material, hooks unless three's empty prototype functions, matrices, draw). Not while a wrapper sits over the executor, for other scenes, or with transmissive items. EXACT (third arm of the same suite + smoke). No measurable node gain. docs/2026-10-26-rust-draw-exec.md | scene3d/draw_exec.js |
   | `drawExecRigs` | `on`/`1`/`true`/`yes` opts in | **OFF** (2026-10-26, lane X, stage 3 S3.6) | `scene3d/draw_exec.js` `drawExecRigsEnabled` = `rustFlag("drawExecRigs", false)`; needs `?drawExec` | **Rigid entity parts through the executor too** (worldRoot's `entities` group as an owned root; SkinnedMesh / InstancedMesh still refused). EXACT (fourth arm of the same suite). Node: entity parts −0.9 µs/draw instead of +0.2 (the pass-through). docs/2026-10-26-rust-draw-exec.md | scene3d/draw_exec.js |

2. Optional, any producer lane (statics.js / static_batch_x.js / pool_registry.js / buildings.js / cells.js): initialise
   `obj.__hbDx = undefined` on the draw objects at construction, so the executor's record field does not add a hidden
   class transition on first draw. Not needed for correctness; measure before bothering.

3. Lane C (`?staticMatrixFreeze`): nothing required — the executor recomputes the front-face sign per draw
   (`matrixWorld.determinant()`, what three does) and validates nothing about matrices (the setters' caches decide the
   uploads), so it is exact with and without frozen matrices. If lane C exposes a per-object matrix epoch later, two
   things can use it: skipping the determinant, and skipping the three matrix setters for BatchedMeshes whose
   model-view is bit-equal to the previous draw's (R3's `mwKey`).

## 6. The SwiftShader smoke (for the orchestrator)

```
capped-build node harness/glsl_smoke/draw_exec_smoke.mjs
```

Four browser launches since R3-2 (§10; five before), one after another (`?drawExec=off`, `=on&drawExecRigs=off`,
`=on&drawExecRigs=on&drawExecRuns=on` — a STALE runs flag, which must be inert — and the shipped default — no flags:
`?drawExec` and `?drawExecRigs` on; lane X2: every other arm names both flags, so no arm rides a default), 160×120 into a 4x MSAA target, reversed-Z when SwiftShader has
`EXT_clip_control` (reported as `depthMode`). Warm-up until a frame adds no async-link deferral, then 8 read-back frames
with a moving camera. PASS = every frame hash equal to the off arm's, max channel diff 0 on the last frame,
`gl.getError() === 0`, no console / page errors, every program linked, the executor executed (fast > 0 and stateOnly >
0) with every hand-over bind issued at three's setup (`vaoFixLate` 0, §3.1), no arm carries S3.2's counters (`runs` /
`runItems` / `hookSkips`; until R3-2: the runs arm formed runs), and the rigs arms executed the entity parts (fewer pass-throughs). The page's logic was
dry-run in node over the fake context (all four arms: no errors, warm-up ends after 4 frames, runs form, rigs cut the
pass-throughs 160 → 88); pixels are the smoke's job.

## 7. Risks — what node cannot prove and the smoke / the 1070 must settle

1. **The VAO model against a real driver.** The executor keeps three's believed VAO and the real binding apart and
   reconciles them (suppressed binds, the hand-over bind at three's own setup point, `deleteVertexArray` of the bound
   VAO reverting to 0). The
   fake has no VAO semantics; the suite proves the call stream equals stock's, which is sufficient only if the driver
   behaves as GL ES 3.0 says. `__drawExec.verify()` reads `VERTEX_ARRAY_BINDING` / `CURRENT_PROGRAM` back in a real
   browser — run it once on the laptop boot (`await __drawExec.verify(120)` → `fails: 0`).
2. **ANGLE / SwiftShader pixels:** the smoke. A failure there with an identical node stream would point at a GL
   semantic the fake does not model (VAO element-buffer binding, texture-unit state).
3. **three r184 coupling:** the executor checks seven source premises of three's renderBufferDirect at install (refuses
   otherwise), the batching samplers' setter name (`setValueT1`), and reads `renderer.properties` fields
   (`currentProgram`, `receiveShadow`, `lightProbeGrid`), uniform `cache[0]`, `program.getAttributes()`, BatchedMesh
   `_multiDraw*` / `_matricesTexture` / `_indirectTexture` / `_colorsTexture`. The setup hook (§3.1) wraps each
   WebGLProgram's own `getAttributes` and the push of the list behind `renderer.info.programs`; its six premises live in
   closures the install cannot read (`THREE_SETUP_PREMISES`: setup's bind decision directly followed by needsUpdate →
   `program.getAttributes()`, `acquireProgram` pushing onto that list, `getAttributes` an own property, setProgram's
   `getUniforms` making the first use), so only the suite checks them. A three bump re-runs the suite.
4. **Hook assumptions** (the setMaterial skip; S3.2's hook skipping went with S3.2): only three's own empty prototype functions and the
   BatchedMesh prototype chain AS INSTALLED (L1 → per-camera → three) are treated as not touching WebGLState. A later
   prototype patch is simply not trusted (no skip). The suite has statics with state-changing own hooks.
   The two hook-driven divergences the integration review found (`review3/r5_shadow_unit_hook.mjs`: a hook binding a
   texture between two continuation draws of one lit material, which setProgram's per-draw shadow-map binds would have
   repaired; `review3/r4_shared_vao_swapback.mjs`: a foreign mesh sharing geometry + material re-setting the shared VAO
   around its own draw) are fixed exactly since lane X2 (§9.2: a texture epoch, a VAO content generation), each with
   suite scenarios and mutants; both repros now give identical streams.
5. **The gain is smaller than R3's estimate** (§4: ~0.25 ms/frame at Holtburg for S3.1 alone, ~0.5 with
   `?drawExecRigs`, against R3's 1.1 ms) and is all main-thread JS; CrGpuMain sees the same commands. Every draw that is
   not executed pays ~0.2 µs for the coherence bookkeeping, so the executor's value grows with the executed share.
   The smoke has an arm per flag (its world has six rotating entity parts for `?drawExecRigs`).
6. **Diag wrappers over the executor** (frame_split, the census probe): they see every draw; with `?drawExec` they time
   the executor, not three. The census probe's `rbd_<kind>` tags still attribute.
7. **Stock findings the suite surfaced (not caused by the executor):** (a) async_link's off-frame compile prepares each
   object's own material, never a `scene.overrideMaterial`, so override draws of a kind async_link has not linked stay
   deferred — relevant to `?portalStencil`; (b) one class material shared by a coloured and an uncoloured BatchedMesh
   makes three re-resolve the program (getParameters + the cache-key string) at every alternation, 50–90 µs a draw in
   node; (c) a material drawn into targets of different output colour spaces (the transmission target, RTs vs canvas)
   has two programs and three switches between them on every pass change.

## 8. Verification commands

```
cd apps/holtburger-web
node tests/draw_exec.test.mjs                 # identity suite (R3-2: 318 checks, 22 scenarios x 3 arms, ~25 s)
node tests/draw_exec.test.mjs --bench-calls   # median µs per call by executor path (rotated chunks; the robust one, §9.4)
node tests/draw_exec.test.mjs --town          # a town-shaped frame: executed share, census by kind, per-call medians (§9.3)
node tests/draw_exec.test.mjs --bench-scenes  # frame time per draw on controlled scenes (shared laptop: see §9.4 before quoting)
node tests/draw_exec.test.mjs --bench         # per-kind µs on R3's population (a few minutes; quiet machine)
node tests/batched_runs.test.mjs && node tests/batched_runs_sorted.test.mjs && node tests/batched_runs_stable.test.mjs
node tests/static_early_out.test.mjs && node tests/pool_runs.test.mjs && node tests/atlas_geom_dedup.test.mjs && node tests/structure_p0_probe.test.mjs
node test_skip_empty_multidraw.mjs && node test_async_link_guard.mjs && node tests/async_link_key_sig.test.mjs
node tests/uniform_bind_patch.test.mjs && node tests/webgl_restore_render_patches.test.mjs
capped-build node harness/glsl_smoke/draw_exec_smoke.mjs   # orchestrator only (browser)
```

## 9. Lane X2 (2026-10-26): the two hook divergences fixed exactly, coverage, the fast path

Took over from lane X after `?drawExec` / `?drawExecRigs` went DEFAULT ON. Same bar: the full GL call stream identical to
flag-off in every scenario, every new behaviour with a mutant the suite catches. Node only (laptop rule); the smoke is
the orchestrator's (§6).

Files: `scene3d/draw_exec.js` (everything below), `scene3d/batched_runs.js` (`newBatchedRunsCache`, an optional
third argument to `batchedRunsBeforeDraw`, the run state's `sum` / `sumOk` / `dead`; the wrapper is unchanged),
`scene3d/skip_empty_multidraw.js` (`skipEmptyMultiDrawWouldSkip`), `tests/draw_exec.test.mjs` (PART 1, six
scenarios, new events, `--bench-calls`, `--town`, `--bench-scenes` rotation, `DX_DUMP`, `RUNS_MODULE`),
`harness/glsl_smoke/draw_exec_smoke.mjs` (arms), this doc (§1, §4, §6, §7.4, §8, §9). Not index.js, not url-flags.md
(row text: §9.7).

### 9.1 Default-on follow-up

- Suite PART 1 asserts the defaults (`drawExec` and `drawExecRigs` on, `drawExecRuns` off — since R3-2: deleted and
  inert, §10), the four URL escapes
  (`off`/`0`/`false`/`no`, read through `globalThis.location` with rustFlag's memo cleared), the seam, install refused
  under `=off` and installed under the bare default. Every arm passes `force` / `runs` / `rigs` explicitly (the `--bench`
  arms did not: with rigs default on they would have executed entities).
- The smoke's `?drawExec=on` arm had silently gained rigs (default on), so its "rigs cut the pass-throughs" comparison
  could only fail. Every arm now names every flag, and a fifth arm runs the shipped default (no flags): it must match
  the off arm's pixels, execute, cut the pass-throughs like the rigs arm and form no runs.

### 9.2 The two hook-driven divergences (§7.4), fixed exactly

**(a) Texture epoch** (`review3/r5_shadow_unit_hook.mjs`). setProgram re-binds a lit program's shadow-map samplers
(`directionalShadowMap` / `spotShadowMap` / `pointShadowMap`, units 0.., allocated first) on every draw, GL-silent
while the units still hold them; a continuation skips that. Now: `texEpoch` counts every GL `bindTexture`, `texSnap`
is its value when the last program-setting draw ended (three's draw, or a continuation after its own batching binds,
which land on units after the shadow ones), and a record whose program has shadow samplers (`rec.shadowMaps`:
`mp.needsLights` and one of the three uniforms in its map) continues only at `texEpoch === texSnap`; otherwise the
draw takes the state-only call, whose setProgram re-binds them (`stats.texDemoted`). Exact by construction (the
demoted draw is three's own setProgram). Cost: zero with shadows off (the default): the `bindTexture` hook goes in with
the first record that has shadow samplers. With shadows on: one increment per real GL texture bind, one compare per
continuation.

**(b) VAO content generation** (`review3/r4_shared_vao_swapback.mjs`). A record's VAO is three's binding state for
(geometry, program), and that state's attribute cache is shared by every object drawing the geometry with the
program: a foreign mesh whose hooks swap an attribute / the index around its own draw re-saves it, and stock's next
setup for the recorded object re-points the VAO back. Now every `vertexAttribPointer`, `vertexAttribIPointer` and
`disableVertexAttribArray` bumps the generation of the VAO bound in GL (after a hand-over fix, three's own), and a
record is valid only at its generation (`invalid.vaoContent`; deletion bumps it too, so one compare replaces the old
`dead` read). Why that is exact rather than heuristic: a recorded state has its position location enabled (new record
refusal `noPosition`: position active in the program and present in the geometry), and a re-save with other
attributes runs setupVertexAttributes with that VAO bound, which either points position again (present and uploaded)
or disables its location — so no re-save is GL-silent. enable / divisor / ELEMENT_ARRAY_BUFFER binds only ever come
with one of those three calls. A raw foreign call on a bound VAO is invisible to three's cache in both arms alike.
Cost: the bumps run only in re-setups (none in steady state).

Suite scenarios (both new): shadows + hooks staging a texture (`renderer.initTexture`) before continuation draws of a
lit material — plain statics and a pool (`texDemoted` 18); the shadows scenarios assert `texDemoted === 0` (the
snapshots must not cost continuations); a foreign mesh sharing a non-indexed geometry + material swapping uv (pointer
re-saves only), the index, and every attribute for never-uploaded clones (disable-only re-saves), an integer-position
RawShaderMaterial pair (IPointer only), and a position-less indexed pair whose re-save is silent but for an index bind
(kept exact only by the `noPosition` refusal) (`vaoContent` 33). Plus lifecycle teeth the suite lacked: a shared
geometry and a shared material disposed mid-run (events), and a material disposed while its statics stay (a dedicated
scenario: a continuation must not compare `receiveShadow` against three's dropped properties object).

### 9.3 Coverage: what the town's draws are, and what changed

From the code paths and the stats definitions [C]:
- **full** = a draw that went through the whole chain under the executor: a first record, a re-record after an
  invalidation, a per-draw chain need (`asyncLinkStamp`, `uniformsNeedUpdate`), and — the bulk of a boot right after a
  teleport — draws that produced no record: async_link deferring a new material while it links (no setProgram), and
  BatchedMeshes empty since their first draw (skip_empty skips inside the chain, so they never get a record and counted
  as full every frame; a recorded one that empties counts as `empty`). The laptop boot (~25–50 SwiftShader frames)
  had 2,205 records and 550 invalidations of its 6,003 full draws; the rest are those no-record draws, a streaming
  transient plus the never-recorded empties.
- **notStatic** = the structural refusal for objects outside the owned roots. In a town: the occlusion proxies (a
  main-scene group `occlusion-proxies`, ~60 a frame at Holtburg per R2's laptop count), the hello-cube, non-instanced
  particle meshes (main-scene children), the grass ring (worldRoot child, InstancedBufferGeometry), and — with
  `?farRing` — far-terrain patches, which are worldRoot children (not under `terrain`).
- **instanced** = InstancedMesh: particle buckets (`particle_manager.js`, main-scene children, transparent, per-emitter
  materials) and the animated-scenery buckets (4 a frame at Holtburg).
- **scene** = other scenes through the main renderer: the sky scene (rendered twice: the sky pass and SkyCapturePass),
  the post passes (one quad and one render() each), the late-FX scene, cloud overlay, SSAO / haze / glow / decal
  passes, portal apertures. Every one is a one-off draw across render() boundaries: a switch at best, nothing to gain
  (≈ 0 per switch; the pass-through costs ~0.1–0.2 µs).
- **churn** = a record refused for a cool-down after three consecutive material-version moves or program moves. No
  per-frame version bump is visible in the code paths the executor owns (fades bump at their edges, ramps and UV
  scroll write uniforms only); the source in a town needs data — `__drawExec.census()` (below) names it by kind.

Changes (all exact; each with a scenario and a mutant):
1. **The occlusion proxies are owned** (`SCENE_ROOT_NAMES`, matched by name at classification), and the `noAsyncLink`
   material refusal is gone (it was "nothing to gain", not exactness: async_link stamps them like any other material).
   They are back-to-back continuations at the end of the transparent list; their query hooks run in renderObject around
   the executor's draw exactly as around three's.
2. **Empty multi-draws take the wrappers' path up front**, whatever the record says: batched_runs' observe + frame
   count, then skip_empty's skip (`skipEmptyMultiDrawWouldSkip`, a new non-counting predicate, so its live `off` seam
   still hands the draw to the chain). A bucket culled to nothing since its first draw is `empty`, not `full`.
3. **`__drawExec.census(frames)`** (and `censusStart()` / `censusStop(frames)`): every renderBufferDirect call by kind
   (`scene|root group|name|type`) and outcome with refusal / invalidation reasons — the town census in one boot.
   Diag-only: it wraps the chain from outside while it runs (sentinel runs do not form meanwhile).

Not done, and why: InstancedMesh execution (per-object VAO, instanced draw shape, instance attributes — ~33 draws a
frame of mostly unique-material switches: < 0.03 ms/frame); owning other scenes (one-off switches); multi-program
records for program churn (the churned draws cost +0.2 µs as pass-throughs; executing them as switches would save
~0.2–0.4 µs each); a shorter churn cool-down (a material-version move needs async_link's slow path anyway).

**A town-shaped frame** (`node tests/draw_exec.test.mjs --town`, [M-node]: R3's Holtburg census kinds and counts — 187
chunk-bucket draws on 41 materials, 78 cell statics on 40, 64 cell surfaces on 19, 55 singletons on 17, 59 entity parts
on 42, 19 building surfaces on 13, 23 atlas buckets, 4 grass rings, 4 animated InstancedMeshes, a terrain batch — plus
60 occlusion proxies, 20 chunk buckets culled to nothing since their first draw, 30 particle InstancedMeshes, a sky
scene of 6 drawn twice and 12 post quads: 628 calls a frame; shipped defaults; steady state):

| | executed (fast + state-only) | empty path | full | pass-through |
|---|---|---|---|---|
| lane X's coverage | 77.0 % (288.6 + 195.0 /frame) | 0.1 % | 21.0 /frame (the never-recorded empties, `noRecordTaken`) | 123.0 /frame |
| lane X2 | **86.6 %** (347.6 + 196.0) | **3.4 %** (21.4) | 0.0 | 63.0 |

The proxies became 59 continuations + 1 switch a frame. What still passes through on this frame is only what §9.3
lists as not worth owning: 30 particle buckets + 4 animated (instanced), 12 sky + 12 post draws (other scenes), 4 grass
rings (notStatic) and the terrain batch (`noBatchingSamplers`: its test shader declares no batching samplers; the real
one, terrain_batch.js under `?terrainNoDrawId` (default on), samples `batchingTexture` but not `batchingIdTexture` —
the laptop boot's 23 `noBatchingSamplers` are that one draw a frame. Owning it would mean binding only the samplers its
program has; one draw a frame, not done). Paired time inside renderBufferDirect (median of 41
rounds of per-round differences, same process): executor vs stock **−0.75…−0.78 ms/frame** (whole frame −0.57…−0.66);
lane X2 vs lane X's executor −0.12 ms/frame (coverage −0.08, the fast-path cuts of §9.4 −0.06). Whole-frame differences
between two executor variants stay within ±0.05 ms on this laptop (§9.4: noise).

### 9.4 The fast path

**Where the time goes** (`node --cpu-prof` over 2,000 frames of a --bench-scenes scene, the executor's subtree per
draw; profiled times run ~2× the bench's):
- *Plain continuation:* three's matrix setters are the largest single item (`setValueM4` ~0.6 µs self in the profile:
  two 4×4 uploads a draw — compare, Float32Array conversion, cache copy). Irreducible: stock issues the same calls with
  the same data. Next the fake GL's own draw bookkeeping (~0.25, fake-only). The executor's own JS is diffuse: ~50 lines
  of 0.005–0.1 µs each (the wrapper prologue, ~25 validation loads, the continuation checks, the call boundaries).
- *BatchedMesh continuation:* three's `setTexture2D` for the 2–3 batching textures was 23 % of the executor's time
  (`WebGLProperties.get` — a WeakMap lookup per texture — plus its generic checks), batched_runs' per-draw part 12 %
  (three weak lookups: `_eligible`, `_stable`, `_runState`), then the canonical element-count sum and the
  executor's own GL / extension hook frames around its own draw.

**Cuts** (exact; each has a suite scenario and a mutant, §9.5):
1. *Batching texture binds through cached properties.* Per record and texture slot: the texture, three's properties
   object for it and a dispose token. Same texture, token alive, three's own `setTexture2D` still the installed one
   (captured with `textures`) ⇒ exactly what setTexture2D does for a plain DataTexture: an upload through three's own
   setTexture2D when `version > 0 && props.__version !== version`, else `state.bindTexture(TEXTURE_2D,
   props.__webglTexture, TEXTURE0 + unit)`. Otherwise the call itself, and re-cache. (Plain = not video / render-target
   / external, own flags fixed at construction; a restore re-takes records and empties the caches.)
2. *batched_runs' lookups through a per-mesh cache* (batched_runs.js `newBatchedRunsCache()`,
   `batchedRunsBeforeDraw(renderer, object, cache)`; the wrapper keeps the uncached call): the mark (permanent: there
   is no unmark), the L1 record (created once, never replaced), the run state of the last canonical texture
   (re-validated each draw: the same texture and not disposed — the state's `dead`, set by the canonical texture's
   dispose listener). Same effects, same stats.
3. *The canonical element count* three's renderMultiDraw sums into `renderer.info` kept by the run state while
   batched_runs verified the canonical list unchanged (`st.sum` / `sumOk`, dropped at every canonical copy and on a
   fallback).
4. *The executor's own draw calls go past its own hooks* (`drawElements` / `drawArrays`, the instanced multi-draws)
   while those hooks are the installed ones — they only test `armed` / `observing`, both false there. A wrapper
   installed over them since (a draw-call census) is called as is.
5. *Validation trims:* vertexTangents / vertexAlphas — the two program-variant inputs setProgram re-derives from
   material and geometry — evaluated as three does, reading normalMap / anisotropy only with a tangent attribute and the
   colour attribute only with vertex colours on (replaces the mVC / mNM / mAn / hasTangent / hasColor4 fields); the
   async-link stamp compared with the already-validated version; the record head read once; the group-less draw range
   from the record's precomputed start / end (`Math.min` with the live count, as three); renderer clipping captured
   once per render() where three captures it (a `renderLists.get` hook: three's only call site, right after
   `_localClippingEnabled` / `clipping.init`) — three's setProgram uses that capture, so this follows three more
   closely than the old per-draw read (a hook turning clipping off mid-render used to let the executor run while three
   still clipped).
6. *The setMaterial-skip check* uses the front face the executor itself last passed (`smFF`), instead of a second
   determinant of the previous object; after three's setMaterial it re-derives as before.
7. The executor's redundant skip_empty test (the wrapper's empty path takes every empty draw while skip_empty is on).

**Results** [M-node], `--bench-calls`: median µs per renderBufferDirect call by the executor's path (outer timer, ~0.1
µs, in every arm), paired per round against the pre-cut executor loaded in the same process (61 rounds × 8 frames,
load average ~1):

| Scene (300 draws) | stock, every call | before the cuts | lane X2 | paired Δ (lane X2 − before) | lane X2 − stock |
|---|---|---|---|---|---|
| pools: BatchedMesh continuations | 3.44 | 1.93 | **1.34** | **−0.59** (BM state-only −0.25) | −2.11 |
| static: plain continuations | 2.04 | 1.12 | 1.11 | ±0.01 | −0.94 |
| proxies: 240 statics + 60 occlusion proxies | 2.34 | 1.13 | 1.10 | −0.03 | −1.22 |
| entities: parts, matrices moving (rigs) | 2.59 | 1.34 | 1.29 | −0.06 | −1.30 |
| switch: a material per draw (state-only) | 5.11 | 5.06 | 5.05 | ±0.01 | −0.06 |

Lane X's own method on R3's population (`--bench`, same table as §4): BatchedMesh
continuation **3.74 → 3.21 µs** (stock 6.09), plain continuation 2.41 → 2.31 (stock 3.65), BatchedMesh state-only
14.57 → 14.17 (stock 14.53); render() p50 **−8.5 %** vs stock (§4: −5.5 %). The plain continuation sits near its floor
in node: what is left is three's own setters and the call boundaries (above).

**Benching on this laptop.** Frame-time A/Bs (`--bench-scenes`, lane X's method) were unusable while other lanes ran:
two arms running IDENTICAL code differed by up to 0.5 ms/frame, the last-created arm was the fastest whatever its code,
and the load average sat at 2.3–3.5 on 2 cores / 4 threads. `--bench-calls` (per-call medians over ~10⁵ calls, paired
per round) puts two identical arms within 0.02 µs of each other; the absolute values still scale with the load
(the per-call table: load average ~1; the town runs: ~2.4), the paired differences are the result. `--bench-scenes` now rotates the arm order
and reports medians too.

### 9.5 Suite, mutants, determinism

**Suite:** 22 scenarios (lane X's 16 + 6), **401 checks, all pass** [M-node] (PART 1: flags, premises, install, the
census seam, the cached binds yielding to a wrapped `textures.setTexture2D`). New scenarios: the texture-epoch
world; the foreign-re-setup world (uv / index / fresh-clone swaps, an integer-position pair, a position-less pair); a
material disposed while its statics stay; hooks flipping `normalMap` / `vertexColors` right before a continuation;
batching textures disposed and drawn again + renderer clipping on for three frames + GL-level wrappers installed over
the executor's hooks; the occlusion-proxy world with a bucket empty since its first draw and skip_empty's `off` seam
toggled. The events scenario gained a shared geometry and a shared material disposed mid-run.

**Determinism trap found (stock, not the executor):** async_link compiles a re-drawn disposed material off-frame against
a 500 ms WALL-CLOCK light cache (`targetFor`, `LIGHT_CACHE_MS`), so a compile within 500 ms of a light change uses
the old light set: wasted, and three then links the right program synchronously at the draw — the hitch async_link
exists to avoid. In the suite it made two arms compile different programs depending on their timing (the material
dispose now precedes the light change). In the product it matters only if light COUNTS change at runtime (they key the
programs); worth a look by whoever owns light pooling.

**Mutants:** 63 (lane X's 31 re-anchored to the new code + 32 new), **61 caught**. New, all caught: X1–X4 (texture
epoch: no demotion; no snapshot after the continuation's own binds; none after three's draw; no shadow flag), X5–X11
(VAO generation: no check; no pointer bump; no disable bump; no bump on deletion; no material-dispose check; no integer-
pointer bump; no `noPosition` premise), C1–C4 (the empty path without batched_runs' part, without skip_empty's count,
ignoring skip_empty's off seam; the proxies not owned), T1–T13 (the cached bind without its upload path; no dispose
check on the matrices / id texture caches; the direct draw / multi-draw calls ignoring a wrapper over the hooks; the
element-count sum without its validity flag; the front-face cache trusted after three's setMaterial; no vertexTangents
/ vertexAlphas check; clipping never re-captured; the draw-range fast path ignoring the index; a batched_runs cache that
calls every mesh marked; the cached binds ignoring a wrapped setTexture2D), B1–B4 (batched_runs: the mark cached as
true; the run-state cache ignoring disposal / the canonical texture; the sum kept across a canonical copy). Three needed
stronger scenarios before they died (T2 / T3: the disposed textures must be bound through the cache by continuations —
a whole pool material run, unmarked building batches; T9: the vertexColors flip must start from records taken
without any flip). T10 dies on the coverage check only: executing under renderer clipping kept the stream identical in
the suite, so the `rendererClipping` refusal is conservative (kept). Survivors: lane X's M24 (the "no runs with
transmissive items" guard: conservative) and M30 (the late-fix fallback: idle while the setup hook adopts every
program), as §3 says. Generator and runner: `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-26-scratch/mutx2/make.mjs`, `mutx2/run.sh` (`DX_MODULE`, plus
`RUNS_MODULE` for the batched_runs mutants; the suite reads both).

**Regression (targeted, one at a time):** batched_runs (69), batched_runs_sorted (58), batched_runs_stable (42),
test_skip_empty_multidraw (11), pool_runs (138), static_early_out (85), rust_entity_world (84), atlas_geom_dedup (114),
csm_receiver_worldpos (48), terrain_batch_no_drawid (119), vertex_pull_spike (54), structure_p0_probe (179),
test_async_link_guard (36), webgl_restore_render_patches (31): all pass. Smoke: `capped-build node --check` passes.

### 9.6 For the orchestrator

1. `capped-build node harness/glsl_smoke/draw_exec_smoke.mjs` — five arms now (§6); the fifth is the shipped default.
   (Four since R3-2, §10.)
2. One Holtburg laptop boot: `await __drawExec.census(60)` names what the town's `full` / `churn` / `notStatic` /
   `instanced` / `scene` draws are (by kind), and `await __drawExec.verify(120)` must stay `fails: 0`;
   `__drawExec.stats.texDemoted` should be 0 in the product (no hook re-binds units) — a non-zero count names a hook
   worth knowing about.
3. The url-flags row text (§9.7) — `drawExec` only; `drawExecRuns` / `drawExecRigs` unchanged.

### 9.7 Requested edit: `docs/url-flags.md`, the `drawExec` row (the `drawExecRuns` / `drawExecRigs` rows stand)

| `drawExec` | `off`/`0`/`false`/`no` is the escape; absent or `on`/`1`/`true`/`yes` ⇒ ON | **ON** — DEFAULT-ON 2026-10-26 (lane X, stage 3 S3.1; built default-OFF the same day). Validated on the laptop: exact parity suites through the release wasm, bare-URL and all-flags Holtburg boots with 0 console / page errors and every kernel engaged (SwiftShader), full JS gate; the 1070 A/B is owed (`docs/reengineering/queue-1070/batch-RC-rust-scene-core-2026-10-26.json`) | `scene3d/draw_exec.js` `drawExecEnabled` = `rustFlag("drawExec", true)`; live A/B `window.__drawExec.off = true`; `.stats` (incl. `texDemoted`, `invalid.vaoContent`), `.verify(frames)`, `.census(frames)` (every draw by kind and outcome, with refusal / invalidation reasons) | **Static-world draws executed without three's per-draw re-derivation.** The outermost renderBufferDirect wrapper records an eligible static draw's program, uniform objects, VAO and geometry the first time, validates the record per draw, and then issues exactly what three's setProgram + setup + draw would: a continuation (same program/material/camera as the draw before) binds the batching textures, uploads receiveShadow + matrices through three's setters, setMaterial (skipped when provably a no-op), VAO, draw; a switch lets three's own renderBufferDirect do setProgram + setMaterial with a degenerate group and draws itself. Stands in for batched_runs / skip_empty_multidraw / async_link on those draws (same stats and `__batchedRuns.frame()`). Keeps three's private VAO tracker coherent (suppressed redundant binds; the hand-over bind issued at three's own setup point through a per-program `getAttributes` hook; `.stats.vaoFixLate` must stay 0). Lane X2 (2026-10-26): exact under hooks that re-bind texture units between continuations of a lit material (a texture epoch demotes the continuation to the state-only call, whose setProgram re-binds the shadow maps — `stats.texDemoted`; nothing hooked with shadows off) and under a foreign mesh re-setting a shared VAO (a per-VAO content generation bumped by vertexAttrib(I)Pointer / disableVertexAttribArray; record refusal `noPosition`); also owns the occlusion proxies (`occlusion-proxies`: back-to-back continuations), takes empty multi-draws on the wrappers' own path up front (`stats.empty`, no longer `full` every frame), binds the batching textures through cached three properties objects and caches batched_runs' per-mesh lookups (BatchedMesh continuations 1.93 → 1.34 µs/call in node). Eligible: main scene, Mesh / BatchedMesh under worldRoot's terrain/buildings/statics/cells (+ entities, `?drawExecRigs`) and the main scene's `occlusion-proxies` group, built-in or ShaderMaterial (no wireframe, morph, UBO groups, clipping, transmission, two-pass). EXACT: the full GL call stream identical to flag-off, frame by frame, 22 scenarios (tests/draw_exec.test.mjs, 401 checks; 61/63 mutants caught); pixel smoke harness/glsl_smoke/draw_exec_smoke.mjs (5 arms incl. the shipped default). Node (per call, paired): continuations −0.9 (plain) … −2.1 µs (BatchedMesh) vs stock, switches ≈ 0, other draws +0.1…+0.2 µs; a town-shaped frame (628 draws): 86.6 % executed + 3.4 % on the empty path, −0.75 ms/frame inside renderBufferDirect vs stock; 1070 A/B owed. docs/2026-10-26-rust-draw-exec.md §9 | scene3d/draw_exec.js; index.js (install after installBatchedRuns); batched_runs.js `batchedRunsBeforeDraw(renderer, object, cache)` / `newBatchedRunsCache`; skip_empty_multidraw.js `skipEmptyMultiDrawWouldSkip` |

## 10. Round 3 R3-2 (2026-10-30): `?drawExecRuns` deleted

Plan: `docs/2026-10-29-round3-gpu-driven.md` §2 ("S3.2 `drawExecRuns` — Drop, delete code. Shipped off for no gain.")
and R3-2 ("Delete the `rigMeshAlias` and `drawExecRuns` code"). The evidence is §4: no gain beyond noise in any node
bench; it never went default-on. Node only (laptop rule); the smoke is the orchestrator's.

**What went** (`scene3d/draw_exec.js`, 1,535 → 1,416 lines):
- the reader `drawExecRunsEnabled` (`rustFlag("drawExecRuns", false)`) and the `opts.runs` install option;
- the module-level `RUN_GEOMETRY` (a BufferGeometry built at import);
- per install: `RUN_MATERIAL` (a MeshBasicMaterial), the sentinel pool (`runPools`, `newSentinel`), `owned`,
  `collapse`, `runExec`, and the `list.sort` hook (`hbDxSortRuns`) with its `done` WeakSet;
- the wrapper's sentinel dispatch (`geometry === RUN_GEOMETRY`);
- the seam `window.__drawExec.runs`, and the counters `stats.runs`, `runItems` and `hookSkips`.

**What stays, unchanged:** everything else. That includes the renderLists `get` hook: it always captured the renderer
clipping for the default path (`rcOn`, §9.4 cut 5). Only its install marker is renamed (`__hbDrawExecRuns` →
`__hbDrawExecLists`, non-enumerable). census(), verify(), the records, the coherence hooks and `?drawExecRigs` are
unchanged. `batched_runs.js` and `skip_empty_multidraw.js` are untouched: none of their seams served only the runs path.
`batchedRunsBeforeDraw`, `batchedRunsCall`, `newBatchedRunsCache`, `skipEmptyMultiDrawTake` and
`skipEmptyMultiDrawWouldSkip` are the executor's default path.

**The default path is identical.** With runs off, none of the deleted code issued a GL call. The per-draw path loses
one compare. Install loses one `rustFlag` read, one MeshBasicMaterial and one WeakSet; the import loses one
BufferGeometry. One side effect can be seen outside the GL stream: three's material id counter no longer advances
once at install. Materials created after the executor's install now get ids one lower than before. three's
`painterSortStable` and our program sort compare material ids by difference, so the draw order does not change, and the
GL stream carries no ids (each suite arm already builds its world at different absolute ids). This is an EXACT-class
change, not an eye-test class: no rc-eye shots are needed. The proof is the stream suite below plus the smoke's pixel
identity.

**Suite** (`tests/draw_exec.test.mjs`): 22 scenarios, now three arms each:
- stock;
- `?drawExec` with rigs off;
- `?drawExec` + `?drawExecRigs`.

Before there were four (stock, `?drawExec`, + runs, + runs + rigs). The shipped default (rigs on, runs off) was not a
scenario arm before, only `--town`'s; now it is one.

- Checks: **403 → 318**. Removed: 86 `[runs]`-arm checks (stream, stats and errors in all 22 scenarios, and "sentinel
  runs formed" in 20 of them), plus 2 PART 1 flag checks (default OFF, URL opt-in). The `[rigs+runs]` checks became the
  `[rigs]` checks. Added: 3 PART 1 checks.
- **The three new checks** pin the deletion:
  - (a) the module exports no `drawExecRunsEnabled`;
  - (b) an executor installed under a STALE `?drawExecRuns=on` URL **and** a stale `runs: true` option, after 4
    frames of the suite world, leaves no sentinel item in the sorted opaque list and keeps three's own `list.sort`.
    Precondition: the list holds consecutive owned pairs, so a live runs path cannot pass;
  - (c) there is no `api.runs` and no `stats.runs` / `runItems` / `hookSkips`.

  **They FAIL on the pre-change executor**: the new suite with `DX_MODULE` = the pre-change copy gives 315 passed /
  3 failed, exactly those three ("7 opaque items, 2 consecutive owned pairs, 2 sentinels, list.sort hbDxSortRuns"). On
  the new code: "99 opaque items, 96 consecutive owned pairs, 0 sentinels, list.sort sortDepthBanded". The other 315
  pass on both, so the remaining arms behave the same before and after.
- Mutants: lane X2's generator, parameterised by source file, reruns the same 63 mutants on the pre-change file.
  - **Before: 61 / 63 caught**. Survivors: M24, the runs-transmissive guard, and M30, the idle late-fix fallback, as
    in §9.5.
  - **After: 54 / 55 caught**. The eight S3.2 mutants M19–M26 were retired with their code (their anchors are gone).
    All 55 remaining anchors match the new file. M30 survives, for the same reason as before.
  - Before the deletion, the per-mutant failure split showed that every remaining mutant was also caught outside the
    runs arms. B2 is caught by its own crash, as before. So the deletion lost no teeth.
  - Generator, runner and logs: `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/round3-a/D/mut/`
    (`make.mjs` with `MUT_SRC` / `MUT_OUT` / `MUT_SKIP`; `run.sh`, with a free-memory gate of 2,000 MB; `pre/`,
    `post/`, `pre_results_*.txt`, `post_results_*.txt`).
- Bench modes run without errors:
  - `--bench-scenes` / `--bench-calls`: arms stock, exec, dflt (+ base);
  - `--bench`: arms stock and exec;
  - `--town`: its census is unchanged — 628 draws/frame, 347.6 fast + 196.0 state-only, 21.4 empty, 63.0 pass:
    86.6 % executed, as in §9.3.

**Regression** (targeted, one at a time): `tests/batched_runs.test.mjs` 69 / 0 before and after (file unchanged),
`tests/rust_entity_world.test.mjs` 98 / 0 after.

**Smoke** (`harness/glsl_smoke/draw_exec_smoke.mjs`): four arms, down from five.
- `?drawExec=off`;
- `?drawExec=on&drawExecRigs=off`;
- `?drawExec=on&drawExecRigs=on&drawExecRuns=on` — the stale runs flag must be inert;
- the shipped default (no flags).

Every executor arm must match the off arm's pixels (max channel diff 0) and execute. No arm may carry `runs` /
`runItems` / `hookSkips`, and the rigs arms must cut the pass-throughs. `draw_exec_page.html` needs no change: it
never referenced the runs path. Not run here (browser; orchestrator only).

**Requested edits (files this lane does not own):**
1. `docs/url-flags.md` §12, the `drawExecRuns` row, replaced by:

   | ~~`drawExecRuns`~~ | — (no reader) | **REMOVED 2026-10-30** (round 3 R3-2; was OFF since 2026-10-26, lane X, stage 3 S3.2) | none: `drawExecRunsEnabled` deleted from `scene3d/draw_exec.js`; a stale `?drawExecRuns=on` (or `installDrawExec(…, { runs: true })`) is inert | **REMOVED 2026-10-30 — no reader.** Sentinel runs collapsed consecutive opaque items the executor owned into one render item, whose steps the executor replayed. They were exact, but measured no gain in node and never went default-on; round 3 drops them (docs/2026-10-29-round3-gpu-driven.md §2, R3-2). Deleted: the `list.sort` hook, the sentinel pool, `runExec`, `window.__drawExec.runs`, `stats.runs` / `runItems` / `hookSkips`, and the suite and smoke runs arms. `?drawExec` / `?drawExecRigs` are unchanged: the GL call stream of both arms is identical to stock in all 22 suite scenarios. Pinned by tests/draw_exec.test.mjs PART 1 ("drawExecRuns deleted: …"). docs/2026-10-26-rust-draw-exec.md §10 | scene3d/draw_exec.js |

2. `docs/url-flags.md` §12, the `drawExec` row, two substrings:
   - "22 scenarios (tests/draw_exec.test.mjs, 401 checks; 61/63 mutants caught); pixel smoke
     harness/glsl_smoke/draw_exec_smoke.mjs (5 arms incl. the shipped default)" →
     "22 scenarios × 3 arms incl. the shipped default (tests/draw_exec.test.mjs, 318 checks; 54/55 mutants caught —
     `?drawExecRuns` and its arms deleted 2026-10-30, round 3 R3-2); pixel smoke harness/glsl_smoke/draw_exec_smoke.mjs
     (4 arms incl. the shipped default)";
   - "docs/2026-10-26-rust-draw-exec.md §9 |" → "docs/2026-10-26-rust-draw-exec.md §9, §10 |".
3. `docs/url-flags.md` §12, the `drawExecRigs` row: "EXACT (fourth arm of the same suite)." → "EXACT (the rigs arm of
   every scenario of the same suite — the shipped default — and of the pixel smoke)."
4. `docs/url-flags.md` §12 intro: "and `drawExecRuns` (no gain), which stay OFF." → "and `drawExecRuns` (no gain),
   which stayed OFF; `drawExecRuns` was deleted on 2026-10-30 (round 3 R3-2)." This needs merging with whatever the
   `rigMeshAlias` deletion does to the same sentence.
5. `harness/run-js-headless.mjs`, the gate entry:
   - comment: `// Lane X (stage 3): ?drawExec / ?drawExecRigs — the full GL call stream` and
     `// identical to stock three + our wrappers, frame by frame (fake WebGL2, 22 scenarios; ?drawExecRuns deleted R3-2).`
   - entry: `{ tier: 5, flag: "drawExec+drawExecRigs", file: "tests/draw_exec.test.mjs" },`
   - the browser-smoke list: ``{ file: "harness/glsl_smoke/draw_exec_smoke.mjs", why: `drawExec / drawExecRigs (static + rig scene, every arm vs stock, a stale ?drawExecRuns=on inert, max channel diff 0) — ${BROWSER_WHY}` },``
