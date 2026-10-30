# Lane F — per-frame hot spots no other lane covers (2026-10-26)

Part of the Rust scene-core day (`docs/2026-10-26-rust-scene-core.md`). Scope: the per-frame main-thread JS that
no other lane owns — 2.76 ms/frame of self time in total on the 1070 (2026-10-23, ultra, running south from
Holtburg), a long tail. Goal: cheaper, with every value that reaches the screen and every observable order
unchanged. Evidence tags as in the plan: **[M]** measured, **[D]** derived, **[C]** code read.

Numbers: 1070 costs are per-frame SELF time from the three `on-r{1,2,3}-run.cpuprofile` files (frames = profile
seconds × fps, the scene-core doc's convention), with line-level `positionTicks`. Bench numbers are node 20 on the
laptop (i5-6300U, shared with other agents — noisy; ranges are repeated runs, terrain pushes are min-of-5 with one
arm per process). Laptop node is a different CPU from the 1070: read ratios, not absolutes.

## 1. Result

| Item | 1070 self [M] | Why it cost that | Change | Flag | Bench before → after |
|---|---|---|---|---|---|
| `syncBatchMatVariants` batched_material_variant.js | 0.243 ms | megamorphic KEYED loads `mat[k]` / `v[k]` (~400 variants × ~19 hot keys × 2, descriptor search on ~70-property objects) | generated straight-line mirror per distinct key list, named access | `?hotMatVariant` | 733–1,148 → 134–211 µs/frame (400 variants) — ~5× |
| `programSortStable` draw_sort_program.js | 0.182 ms | every comparison re-derived both sides' phase (2 calls), `material.id` and program key (megamorphic loads) | the same comparator over a per-render-item memo of numbers (no references) | `?hotDrawSort` | 1,474–1,680 → 755–811 µs per 1,197-item sort — ~2× within a run |
| `step` vitals-orbs.js (+ native `getAnimations`) | 0.191 + 0.109 ms | a CSSAnimation `playState` read FLUSHES STYLE [C]; read-write-read per loop forced one style update per loop + one per pane | all reads (lists, adoption, playState) before all writes | direct HUD fix | style flushes per tick 9–11 → 1 (model); JS side 6.1 → 5.6 µs/tick; the native saving is owed on the 1070 |
| radar repaint (`flushPixels` + `fillRect`) radar.js | 0.017 + 0.032 ms | one k×k `fillRect` per blip pixel per repaint (every 25 ms while moving) | each pixel set cut once into merged rects | direct HUD fix | 42% fewer `fillRect` calls (CROSS 5→3, CENTRE 9→3, selection 20→4) |
| `_pushCloudShadowsToTerrain` cloud_volume.js | 0.066 ms | ~6 uniform-name lookups per terrain material on ~150-entry (some dictionary-mode) uniforms objects; Matrix4.copy re-reads the source per material | one lookup per uniform; source elements read once | `?hotCloudPush` | min-of-5: 60–64 → 50–52 µs/frame (541 materials) — −13…−23% |
| `tickTerrainUTime` loop.js | 0.053 ms | `mat.uniforms.uTime` walked twice per material | one lookup per uniform; breath test hoisted | `?hotTerrainTime` | min-of-5: 21.8–22.8 → 14.6–14.9 µs/frame (541 materials) — −32…−36% |
| `_search` / `_params` night_ramp.js | 0.034 + 0.020 ms | `artSunPitchDeg` asked 3 readers, each re-reading `window.location.search` (native getter, fresh string) | one URL read per call | `?hotNightRamp` | 2.67 → 1.00 URL reads/call; 5.2 → 2.1 µs/call with a getter costed like a native one |

Expected on the 1070 [D] (not measured): material sync ~0.19 ms, sort ~0.09 ms, orb step most of its 0.19 ms self
plus part of the 0.11 ms in getAnimations, radar ~0.015 ms, cloud push ~0.01 ms, terrain time ~0.02 ms, night ramp
~0.025 ms — **~0.4–0.55 ms/frame** with the five flags on and the two HUD fixes (live now).

No Rust module from this lane: every item above is bound to JS objects (materials, three's render items, DOM
animations, a canvas, uniform objects, the URL). A wasm kernel would still need JS to do the same loads to feed it.
The one numeric item, the grass tile cull, is 64 tiles with a JS `zRange` callback per tile — the crossing and the
marshalling would cost about what the function costs (§3).

## 2. Items

### F1 — batched-material variant sync (`?hotMatVariant`, default OFF)

`syncBatchMatVariants` mirrors each statics bucket's variant material from its member once per frame: the hot key
list every frame, every key on a 1/32 round-robin sweep and on a version bump. `_mirror(v, mat, keys, changed)`
reads `mat[k]` and `v[k]` with a VARIABLE key: with a dozen material hidden classes those are megamorphic keyed loads,
each a descriptor-array search on ~70-property objects.

The flag compiles, once per distinct key list (`JSON.stringify(keys)`, ≤ 512 lists, then `_mirror` again), the same
statements as straight-line named access — `x = m.opacity; if (v.opacity !== x) { v.opacity = x; if (c) c.push("opacity"); }`
— in the same key order (non-identifier keys as `["…"]`). The loop around it is the shipped one branch for branch,
including `i++` counting only entries whose version did not move (the sweep schedule). Entries cache the function
for their current `hot` / `keys` list (`hotFn` / `fullFn`, dropped when the list changes). The page already compiles
code from strings (`new Function` for the BASIS transcoder); a CSP that forbade it would make the compile throw,
which falls back to `_mirror` (still exact).

Identity: `tests/hot_mat_variant.test.mjs` — two module instances (flag off / on) mirror the same 261 members
(4 material classes; decorations in varying order; integer-like, non-identifier and `__proto__` own keys; an own
enumerable accessor) through 1,600 frames of opacity fades, map re-seats, needsUpdate, cold-key changes, new keys
after a bump, keys added without one, and holds/releases that drop and re-create variants. After every sync every
variant pair has the same own keys in the same order, Object.is-equal values (full descriptors every 50th frame) and
the same prototype, and the per-entry keys / hot / version lists match (390,028 comparisons); the accessor was read the same
number of times by both paths. A mutation (dropping the last key of long lists) fails it.

Specialising further — one function per member key SEQUENCE, so each sees one hidden class — measured another
~20–40% but compiled 150 functions instead of 34 on the bench population (unbounded in the field). Not taken.

### F2 — program-grouped opaque sort (`?hotDrawSort`, default OFF)

`programSortStable` is three's `painterSortStable` with the ?punchRetail phase first and the compiled program id
after renderOrder. Each of the ~16k comparisons of the main pass called `phaseOf` on both objects, read
`material.id` on both and, at the program level, `programKey` on both (renderer.info chain + three memo loads).

The flag builds the same comparator over a memo on three's render items (one hidden class): `__dspPh` (phase,
eager), `__dspId` (material id, eager), `__dspK` (program key, LAZY — computed only when a comparison reaches that
level, so exactly the materials the shipped code asks `renderer.properties` about are asked, in the same frame) and
`__dspS`, the stamp. The memo holds numbers only: three's `WebGLRenderList.finish()` nulls object / geometry /
material / group on the pooled items a shorter frame leaves unused so that evicted objects can be collected, and the
memo must not undo that. A memo is valid for one sort: the stamp is one object per (comparator,
`info.render.frame` value), and three r184 increments the frame once per render(), right after the sort, so two
sorts never share one. Every other key is read live, and the program key is asked of the item's live material. The ladder and the arithmetic of every key are the shipped ones, so every comparison
has the same sign and V8's TimSort produces the same order, ties included. It composes with lane X's executor: the
order is unchanged, and draw_exec's sort wrapper collapses runs after the sort.

Identity: `tests/hot_draw_sort.test.mjs` — 160 frames, 190,810 items through a pooled list built like three's
(`getNextRenderItem` re-points items; multi-group objects share an id), seven object classes under tagged,
untagged and late-attached groups, the ?punchRetail phase (`_punchPhase`/`_phaseOf` copied verbatim) with
?terrainLast toggling, 400 materials over 80 programs re-bound between frames (some uncompiled), renderOrder
classes, duplicate z and −0, and ?depthBandSort bands through the real `depth_band_sort.js` list wrapper on 40
frames: same order element by element, same materials asked each frame, two renderers' memos kept apart.

Review fix (2026-10-26, adversarial review, both skeptics): the first cut also kept the item's `object` and
`material` in the memo (`__dspO` / `__dspM`, to re-check them on every comparison) and so pinned every evicted mesh
and material until three reused its slot — the review's repro: 199 of 199 evicted meshes still reachable (79.4 MB)
against 1 of 199 (9.9 MB) with the flag off. Both fields are gone; validity is the stamp alone. That needed one
premise checked: a render() that throws mid-way (r184 has no try/finally) leaves its list on `renderListStack` for
good, so every later render of the scene sorts a DEEPER list whose items carry stamps of earlier frame values — the
aborted sort's stamps are never read again (`[7]` below pins it). The one case that premise does not cover: a render
nested inside another render's object callbacks (onBeforeRender …) that throws in or after its sort and whose
exception the callback swallows — the outer render then pops the nested entry and leaves its own, and the next
render of that scene can sort the nested list again under the same frame value. Nothing in the tree renders from
inside a render callback (checked), and three's own render-state stack is left mismatched in that case anyway.
Fixed numbers: 1,474–1,680 → 755–811 µs per sort (the reference-holding cut was ~10% slower than this).

Retention and the abort are pinned on three's real WebGLRenderer over `tests/helpers/fake_webgl2.mjs`: `[6]` renders
600 meshes, evicts 500 (disposing per-LB materials), keeps sorting a 160-item dungeon, collects (WeakRef + gc), and
requires flag on to keep no more than flag off (1/500 meshes, 0/166 materials both; re-adding item references makes
it fail with 440/500, 146/166); `[7]` makes a sort throw part-way, re-points the scene, renders again and requires
the frame to have held, the next sort to have used none of the aborted sort's items, and three's resulting order to
equal the reference comparator's.

Not done: precomputing every item's keys in a render-list `sort` wrapper (as depth_band_sort.js does) would take the
comparator to the floor (~690 µs on the pre-fix bench) but asks `renderer.properties` about every opaque
material, not only those compared at the program level, and adds a fourth wrapper on three's render lists.

### F3 — vitals orbs `?orbAnimSync` step (direct HUD fix)

[C] Blink `CSSAnimation::playState()` = `FlushStyles(); return Animation::playState();` and `FlushStyles()` =
`GetDocument()->UpdateStyleAndLayoutTree()` (css_animation.cc); `Animation::setCurrentTime` →
`SetCurrentTimeInternal` → `SetOutdated()` → `timeline_->SetOutdatedAnimation(this)` (animation.cc). So the shipped
step — per loop: read playState, maybe pause(), write currentTime — made each read service the previous write and
recalc its target's style, and each pane's getAnimations() flushed the previous pane's writes. The profile charges
that native work to the loop's line (`for (const a of anims)`, 0.178 of the 0.191 ms self).

The step now collects every pane's list, does every adoption read and every playState read, then does the writes:
one style update per cadence tick (the first getAnimations). Each animation gets the same calls in the same order
(pause() only when it was not paused, then `currentTime = now − start`), the same adoption, the same exceptions
skipping it, and the live list keeps getAnimations' order; a write touches only its own animation, so no read sees
a different value for being taken earlier. (An animation listed under two panes would get a second pause(), a
no-op on a paused animation per the spec; the panes are disjoint.)

Identity: `tests/hot_orb_anim_step.test.mjs` — the shipped step copied verbatim vs the new one over a model of
Blink's surface (playState and getAnimations flush; currentTime writes dirty; pause() no-op when paused, pending
pause completed by the next currentTime write): same states after every tick and after release, same per-animation
call sequence, same live counts, through loops starting and ending, a finite glare, a not-yet-started loop and loops
that throw from playState / pause / the setter. Flushes per tick: 9–11 → 1. `tests/hud_orb_anim_sync.test.mjs`
(the shipped contract) still passes. Owed: the 1070 trace for the native saving.

### F4 — radar blip repaint (direct HUD fix)

A repaint (each 25 ms update while anything moves) filled each blip pixel with its own k×k `fillRect`. `blipRects`
cuts a pixel set once into maximal row runs stacked over consecutive rows with the same extent; a repaint fills
those rects in op order. Exact because every coordinate is an integer (trunc0 positions, integer offsets, integer
backing scale k, no canvas transform): a covered pixel is fully covered, so one rect and its unit cells composite
identically, and no op paints a pixel twice. Sets with a repeated pixel (0 and −0 included), odd length or
non-integer offsets, and non-frozen arrays, keep the per-pixel loop; only frozen sets (the shape constants) are cached.

Identity: `tests/hot_radar_rects.test.mjs` — unit: every shipped set and ~3,000 random sets at k = 1..4, painted
with an ALPHA colour over a random background (a double fill would show), rasterize identically; refusals are
null. Integration: the real radar, two module instances on fake DOMs with rasterizing 2D contexts, 120 updates
with 70 moving blips of every shape, a selection, dimmed far-z blips, the BlackFog2 blank and a DPR change (k 1→2):
identical canvases after every update, 42% fewer `fillRect` calls, all on the integer grid.
`tests/hud_radar_paint.test.mjs` and `test_radar_projection.mjs` still pass.

### F5 — cloud shadows onto the terrain (`?hotCloudPush`, default OFF)

Per terrain material the shipped loops re-read `u.uCloudShadowEnabled` three times and walk the uniforms object
again for each write; `Matrix4.copy` re-reads the 16 source elements per material. The flag looks each uniform up
once and reads the source elements once per frame; same write conditions and order; a destination that is not a
plain Matrix4 still gets `.copy()`; a source without `elements` runs the shipped loop (and throws where it throws).
Identity: `tests/hot_terrain_push.test.mjs` [1]–[2] — the real `CloudVolume#_pushCloudShadowsToTerrain` on two
registries (per-LB ShaderMaterials with ~150-entry literal uniforms, terrain_batch-style key-by-key clones, entries
without cloud uniforms, a hole, a destination aliased with the source, a non-Matrix4 destination) over 400 frames
across every branch (on, off by flag, off at sunset under ?cloudNight, strength override / day-scaled / NaN / none,
texture swaps, −0): every uniform Object.is-equal after every frame.

### F6 — terrain `uTime` push (`?hotTerrainTime`, default OFF)

`mat?.uniforms?.uTime` was evaluated twice per material (and `mat.uniforms` again for the breath). One lookup per
uniform; the breath test (constant per frame) hoisted; same materials, values and write order. Identity: same test
[3], 200 frames with the crack-glow breath unregistered then registered, −0 times and breaths.

### F7 — night ramp URL reads (`?hotNightRamp`, default OFF)

`artSunPitchDeg` read the URL 2× by day and 3× at night (nightRampEnabled, nightKneeDeg, nightFloorDeg each call
`_params()` → `window.location.search`). Only these readers' own builtins run between those reads, so one read per
call answers all three exactly: same params object, same lookups and clamps, same fail-soft defaults, and no read
where the shipped code made none (`enabled === false`). The two readers' bodies moved into `_rampOnFrom` / `_numFrom`
(shared, unchanged). Identity: `tests/hot_night_ramp.test.mjs` — 3,864 (URL, pitch, enabled) cases, identical
results for `artSunPitchDeg` and `nightFactorFromAuthoredPitch`; a URL rewritten between calls (replaceState) is seen
on the next call as before. Other modules' own single-read calls (`nightRampEnabled()`, `nightEnvScale()`, cloud_night's
`nightNumFlag`) are unchanged.

## 3. Looked at, not changed

| Item | 1070 self | Why not |
|---|---|---|
| `cullGrassTiles` grass_gpu_place.js | 0.050 ms | Allocation-free 64-tile loop; the exact trims (the six planes' coefficients read once per call) measured −10% (7.2 → 6.4 µs/call) — not worth a flag. `zRange` must stay ahead of the plane test (the suite's zRange records its calls). Re-using a ring's verdict across passes with the same camera is not exact unless the height field provably did not change between calls — that belongs in terrain_grass.js `cullRing`. Not a Rust job (64 tiles, a JS callback per tile). |
| `gatherCandidates` radar.js | 0.049 ms | A memory-bound walk of every entity: Map entry, instance, root, position — 3–4 dependent loads each, all needed for an exact answer. The lever is an entity-side index (entities.js). |
| Proxy `get` rejection_feedback.js | 0.037 ms | The trap's own work is a small slice of the Proxy machinery. The one exact saving (answer untracked reads from the bound-wrapper cache before `TRACKED_METHODS.has`) measured within run-to-run noise (−6…−25%, ±30%). Built, measured, reverted. |
| `tickFxRibbons` fx_ribbons.js | 0.036 ms | Walks every entity for `_isProjectile` / `_fxSwingUntilMs` each frame; an exact saving needs entities.js to keep the projectile and swing sets. |
| `collectFxDistortSources` vfx/fx_distort.js | 0.034 ms | The per-source cost is the resolve closure particle_manager.js hands in (`scene.localToWorld` → `updateWorldMatrix(true, false)` per source); the particles lane's file. |
| `_tickPerFrameBody` loop.js | 0.117 ms | On the 10-23 code, 0.0725 of it sits on the `materialCache.tickAnimatedSurfaces?.(dt)` line (materials.js, likely inlined callee work); the body is calls whose order must stay. Nothing exact to trim in the body itself. |

## 4. For other owners (exact edits I would make; not done — not my files)

- **vfx/weapon_fx.js `_syncDelta`** (0.016 ms self + `_syncMaterials` 0.018): the same keyed mirror as F1 —
  `for (const k of MATERIAL_SURFACE_FIELDS) { const v = b[k]; if (v !== s[k]) { m[k] = v; s[k] = v; … } }` over
  materials of several classes. MATERIAL_SURFACE_FIELDS is a fixed list, so one generated (or hand-written)
  straight-line function with named access, statement per key in the same order, keeping the `_PROGRAM_FIELDS.has(k)`
  test inside each changed branch, is exact and should give F1's ~5× on that loop:

  ```js
  // weapon_fx.js, module level after `_PROGRAM_FIELDS` (MATERIAL_SURFACE_FIELDS is frozen):
  const _syncFields = (() => {
    try {
      let body = "var prog = false, x;\n";
      for (const k of MATERIAL_SURFACE_FIELDS) {
        const p = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? "." + k : "[" + JSON.stringify(k) + "]";
        body += "x = b" + p + "; if (x !== s" + p + ") { m" + p + " = x; s" + p + " = x;" + (_PROGRAM_FIELDS.has(k) ? " prog = true;" : "") + " }\n";
      }
      return new Function("b", "m", "s", body + "return prog;");
    } catch (_) { return null; }
  })();
  // _syncDelta: replace the MATERIAL_SURFACE_FIELDS loop with
  //   let prog = _syncFields ? _syncFields(b, m, s) : <the shipped loop>;
  ```
- **terrain.js / terrain_batch.js**: every per-terrain-material push (uTime, sun dir, cloud shadows, IBL, dirt, sand,
  micro …) writes the SAME value into each material's own `{value}` object, 500+ times a frame, and each walk is
  memory-latency bound. Binding one shared `{value}` per frame-constant uniform at material build (the batch clone
  copying the reference, not the value) would make each push O(1). It is a structural change that needs an audit of
  per-material writers (anything writing one material's uniform would then write all), so it is a design decision,
  not an exact drop-in.
- **entities.js**: a projectile / swinging-wielder set maintained where `_isProjectile` / `_fxSwingUntilMs` are set
  would let `tickFxRibbons` skip its every-entity walk.

## 5. Flags (rows for docs/url-flags.md — the orchestrator adds them)

| `hotMatVariant` | `on`/`1`/`true`/`yes` opts in; `off`/`0`/`false`/`no` | **OFF** (2026-10-26, lane F) | `scene3d/batched_material_variant.js` `_genOn` = `rustFlag("hotMatVariant", false)`, read on the first sync | **Generated mirrors for the batched-material variant sync.** `syncBatchMatVariants` copies each variant's changed own properties from its member through one compiled straight-line function per distinct key list (named access, the shipped `_mirror` statement per key in the same order; ≤ 512 lists, then `_mirror`), instead of keyed loads that are megamorphic on ~400 variants. Same values, read/write order, hot lists and sweep schedule (`tests/hot_mat_variant.test.mjs`: 1,600 frames, every variant pair key by key). Node: ~5× (733–1,148 → 134–211 µs/frame, 400 variants); 1070: 0.24 ms/frame self before. docs/2026-10-26-rust-hotspots.md §F1 | scene3d/batched_material_variant.js |
| `hotDrawSort` | same grammar | **OFF** (2026-10-26, lane F) | `scene3d/draw_sort_program.js` `hotDrawSortEnabled` = `rustFlag("hotDrawSort", false)`, read when the comparator is built | **The program-grouped opaque comparator over a per-render-item memo.** Phase (eager), material id (eager) and program key (lazy) are kept on three's render items for one sort — numbers only, no references, so what three's `finish()` releases stays collectable (stamp per comparator × `info.render.frame`); every other key read live; the same ladder, so the same sign for every comparison and the same order element by element (`tests/hot_draw_sort.test.mjs`: 160 frames, 190,810 items, ties, ?punchRetail phase, ?terrainLast, ?depthBandSort; retention and an aborted sort on three's real WebGLRenderer). Composes with `?drawExec`. Node: ~2× per 1,197-item sort; 1070: 0.18 ms/frame self before. One documented boundary: a render nested inside a render callback whose exception the callback swallows (§F2). docs/2026-10-26-rust-hotspots.md §F2 | scene3d/draw_sort_program.js |
| `hotCloudPush` | same grammar | **OFF** (2026-10-26, lane F) | `scene3d/cloud_volume.js` `hotCloudPushEnabled` = `rustFlag("hotCloudPush", false)` | **Cloud shadows onto the terrain with one uniform lookup per material.** `_pushCloudShadowsToTerrain`'s two per-material loops look each uniform up once and read the cloud shadow matrix's 16 elements once per frame; same writes, conditions and order (non-Matrix4 destinations still `.copy()`). `tests/hot_terrain_push.test.mjs` [1]–[2]: 400 frames, every branch, every uniform Object.is-equal. Node: −13…−23% (60–64 → 50–52 µs/frame, 541 materials); 1070: 0.066 ms/frame self before. docs/2026-10-26-rust-hotspots.md §F5 | scene3d/cloud_volume.js |
| `hotTerrainTime` | same grammar | **OFF** (2026-10-26, lane F) | `scene3d/loop.js` `_hotTerrainTimeOn` = `rustFlag("hotTerrainTime", false)` | **Terrain `uTime` / crack-glow breath push with one uniform lookup per material.** `tickTerrainUTime` evaluates `mat.uniforms.uTime` once per material (it walked it twice) and tests the breath once per frame; same materials, values and order. `tests/hot_terrain_push.test.mjs` [3]. Node: −32…−36% (21.8–22.8 → 14.6–14.9 µs/frame, 541 materials); 1070: 0.053 ms/frame self before. docs/2026-10-26-rust-hotspots.md §F6 | scene3d/loop.js |
| `hotNightRamp` | same grammar | **OFF** (2026-10-26, lane F) | `scene3d/night_ramp.js` `_hotNightRampOn` = `rustFlag("hotNightRamp", false)` | **`artSunPitchDeg` reads the URL once per call.** Its three readers (nightRampEnabled, nightKneeDeg, nightFloorDeg) each re-read `window.location.search`; one read answers all three (nothing between them can change the URL): same lookups, clamps and fail-soft defaults, none for `enabled === false`. `tests/hot_night_ramp.test.mjs`: 3,864 cases identical; 2.67 → 1.00 URL reads per call. 1070: `_search` 0.034 + `_params` 0.020 ms/frame self before. docs/2026-10-26-rust-hotspots.md §F7 | scene3d/night_ramp.js |

The two HUD fixes (F3 vitals-orbs step, F4 radar merged rects) have no flag (owner rule: exact HUD perf fixes apply
directly); the existing `?orbAnimSync=off` still turns the whole orb animation sync off.

## 6. Verification (targeted, one at a time)

```
cd apps/holtburger-web
node tests/hot_mat_variant.test.mjs --bench     # F1 identity + bench
node tests/hot_draw_sort.test.mjs --bench       # F2
node tests/hot_orb_anim_step.test.mjs --bench   # F3
node tests/hot_radar_rects.test.mjs             # F4
node tests/hot_terrain_push.test.mjs            # F5 + F6 identity
node tests/hot_terrain_push.test.mjs --bench=off; node tests/hot_terrain_push.test.mjs --bench=on   # repeat, take the min
node tests/hot_night_ramp.test.mjs --bench      # F7
# shipped suites over the same files:
node test_batch_mat_variant_clone.mjs; node test_draw_sort_program.mjs; node tests/depth_band_sort.test.mjs
node tests/hud_orb_anim_sync.test.mjs; node tests/hud_radar_paint.test.mjs; node test_radar_projection.mjs
node tests/cloud_night_lighting.test.mjs; node tests/cloud_shadow_cadence.test.mjs; node tests/retail_light_tick.test.mjs
node tests/environ_override.test.mjs; node tests/ac_moons_fx.test.mjs; node tests/csm_sun_fade.test.mjs; node tests/look_pass.test.mjs
```

Gate entries (harness/run-js-headless.mjs is the orchestrator's; ~0.1–11 s each on the laptop):

```js
  // 2026-10-26 lane F hot spots (docs/2026-10-26-rust-hotspots.md): flag off vs on, frame by frame.
  { tier: 5, flag: "hotMatVariant", file: "tests/hot_mat_variant.test.mjs" },
  { tier: 5, flag: "hotDrawSort", file: "tests/hot_draw_sort.test.mjs" },
  { tier: 5, flag: "orbAnimSync(step)", file: "tests/hot_orb_anim_step.test.mjs" },
  { tier: 5, flag: "radar(rects)", file: "tests/hot_radar_rects.test.mjs" },
  { tier: 5, flag: "hotCloudPush+hotTerrainTime", file: "tests/hot_terrain_push.test.mjs" },
  { tier: 5, flag: "hotNightRamp", file: "tests/hot_night_ramp.test.mjs" },
```

The shipped suites above also pass with all five flags forced on (a preload calling scene_core's
`__setRustFlagForTest(name, true)` for each).

1070 queue (flags on vs off, same route as 2026-10-23): the running-south profile for the five flags together, and a
`devtools.timeline` trace (the scene-core doc §8 run) to see the orb step's forced style updates gone.

## 7. Risks

- F1 compiles code from strings. If a CSP ever blocks eval, it silently falls back to `_mirror` (exact, slower).
- F2 adds four fields to three's render-item objects (`__dspS` the stamp object, `__dspPh` / `__dspId` / `__dspK`
  numbers — no references to objects or materials; one fixed order, one hidden class). Anything that enumerated
  render-item keys would see them; nothing in the tree does.
- F3 changes WHEN style is recalculated inside the orb tick (once instead of per loop), never what it computes; a
  future change that made a write affect another animation's playState (e.g. animating a custom property that drives
  another loop's `animation-*`) would have to revisit the read-first order.
- F4 relies on the radar canvas staying on the integer grid with no context transform; a future `setTransform` or
  fractional scale would need the per-pixel loop (the code already checks integer k, x, y).
- F5 / F6 assume the uniform objects behave as plain `{value}` data (they are terrain.js literals and terrain_batch
  clones); getters on them would be read fewer times.
