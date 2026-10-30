# Lane F2 — more per-frame hot spots, exact (2026-10-26)

Follow-up to lane F (`docs/2026-10-26-rust-hotspots.md`), part of the Rust scene-core day
(`docs/2026-10-26-rust-scene-core.md`). Same rule: every value that reaches the screen, every GL call and
every observable order unchanged. Evidence tags: **[M]** measured, **[D]** derived, **[C]** code read.

1070 numbers are per-frame SELF time from the three `on-r{1,2,3}-run.cpuprofile` files of 2026-10-23
(frames = profile seconds × the run's fps from `on-r*-run.json`: 407.4 / 445.1 / 415.7, i.e. the scene-core
doc's 20.6 ms/frame). Those profiles sample every ~590 µs, so a 10 µs/frame function is ~20 samples over the
three runs: read the small numbers ±25%. Hot functions optimized before the profiler started carry no line
positions (every tick lands on the function's first line). Node benches: node 20 on the laptop (i5-6300U,
shared), one arm per process, arms rotated, min of 5 rounds per process, median of 3 processes.

## 0. Result

| Item | 1070 before [M] | Change | Flag (DEFAULT OFF) | Node before → after [M] | 1070 estimate [D] |
|---|---|---|---|---|---|
| G1 terrain shared uniforms | tickTerrainUTime 0.053 + _pushCloudShadowsToTerrain 0.066 + tickTerrainSunDir 0.0125 ms (≈ 0.10 left after lane F's flags) | one shared `{value}` per frame-constant terrain uniform, bound lazily, frozen on leave; the Gouraud epoch walk only when the registry / epoch moved | `?hotTerrainShared` | 541 materials, the three pushes: 124–185 → 5.2–5.3 µs/frame steady (−96%); a frame whose registry moved 98 → 31 µs | −0.09…−0.10 ms/frame (+ ~0.013 with the IBL patch §G1.6) |
| G2 weapon_fx `_syncDelta` | _syncDelta 0.016 (+ part of _syncMaterials 0.018) ms | generated straight-line mirror of the frozen MATERIAL_SURFACE_FIELDS loop | `?hotWeaponFxSync` | _syncDelta 122 → 28 µs per 80 records (−77%); tickWeaponFx 71 → 24 µs per 40 weapons | −0.012…−0.02 ms/frame |
| G3 GPU grass tile cull | cullGrassTiles 0.050 + heightRange 0.017 ms | per-ring zRange memo keyed by the field's generation stamp; planes read once per call | `?hotGrassCull` | 4 ring culls 29.5 → 14.8 µs/frame (−50%) | ≈ −0.03 ms/frame |

Total on the 1070 [D]: **≈ −0.13…−0.15 ms/frame** (≈ −0.15…−0.16 with the IBL patch), all three DEFAULT OFF.
Every flag is exact by test (identity frame by frame, flag off vs on) and mutation-checked: 28 of 29 rule
breaks fail their suite; the survivor is value-equivalent by construction (§G1.4).

No Rust from this lane: every item is bound to JS objects (three's uniform maps, materials, a closure per
ring). §3 lists what the survey found and why the rest was not changed.

## G1. Terrain shared uniforms (`?hotTerrainShared`)

### G1.1 What

Four pushes write one frame-constant value into every terrain material's own `{value}` object, over the
registry (`scene3d.terrainMaterials`: the per-LB ShaderMaterials — hidden data-carriers under the default-on
`?terrainBatch`, still pushed because readers copy from them — plus the terrain_batch material):

| Pusher | Uniforms | Shipped write |
|---|---|---|
| loop.js `tickTerrainUTime` | uTime; uCrackGlowBreath (crack glow on) | `u.value = X` |
| loop.js `tickTerrainSunDir` | uSunDir; then the epoch-guarded Gouraud set | `value.set(x,y,z)`; per-material `userData.__acLightEpoch` guard |
| cloud_volume.js `_pushCloudShadowsToTerrain` | uCloudShadowEnabled (both branches), Map + Matrix0 (on branch), Strength (finite) | `if (v !== X) v = X`; `value.copy(src)` |
| ibl_environment.js `tick` (not wired, §G1.6) | uIblEnabled, uEnvCube, uEnvIntensity | `u.value = X` |

`scene3d/terrain_shared_uniforms.js` gives each uniform ONE shared `{value}` (a slot). A registry material is
re-pointed at the slot at the first push that writes it after the material joined, and re-pointed back to a
frozen private copy at the first push after it left. A push is then: one pointer compare of the registry
with the pusher's last view, one write per slot, and per-material writes only for the materials that cannot
be shared (none in the field). When the registry moved, one ordered diff per pusher gives leavers and joiners
and each group touches only those (a group more than one diff step behind re-walks); the Gouraud walk visits
only the joiners when the light epoch did not move, and is skipped when nothing moved.

### G1.2 Why it is exact

three r184 reads `material.uniforms[name].value` at upload (`WebGLUniforms.upload` reads `values[u.id]` at
every refresh). For a ShaderMaterial, `values` IS `material.uniforms` (`getProgram`: `parameters.uniforms =
material.uniforms` → `materialProperties.uniforms`), unless an onBeforeCompile replaces the map — terrain
materials have none. So the invariant to keep: at every moment, every material's `uniforms[name].value`
equals what the shipped loops would have left in its own object.

- A material is bound only during a push that writes the uniform, only if it is in the registry at that push,
  only after every group of the push is known hazard-free (so a fallback finds every joiner on its own
  object; the first cut bound joiners while classifying them, and the suite's hazard window caught it), and
  only if its post-push value
  under the shipped rule equals the slot's post-push value under the same rule: always for `=`, `.set`,
  `.copy`; for `if (v !== X) v = X` on numbers, `Object.is` of the two results (they can differ only in the
  sign of a zero — `-0 !== 0` is false). Otherwise it stays private and gets the shipped write each push.
- A leaver keeps the slot until its pusher's next observe, which freezes it at the slot's value BEFORE the
  slot is written: it keeps the last value it was pushed, as today. A pusher that pauses (the cloud push
  indoors: index.js calls `CloudOverlay.preRender` only while the sky shows; the sun push without a sky
  state) has its leavers swept by the every-frame time push after 30 idle frames (exact: a freeze never
  changes a value) — no evicted material is retained.
- A joiner keeps its own object (its seed — `sharedTerrainTimeSec`, the uSunDir literal, …) until the next
  push that writes the uniform: the bake pre-warm draw and the terrain_batch first-absorb clone see exactly
  what they see today.
- Anything the shipped loop would throw on is a HAZARD: the pusher unbinds everything (freezing exact values)
  and the caller runs its shipped loop (or lane F's fast loop), so the partial writes before the throw are
  the shipped ones. Hazards: a non-writable / accessor `value`, a missing uniform the loop assumes (Map,
  Matrix0, uEnvCube, uEnvIntensity, the Gouraud set), a Matrix0 / Gouraud value that is not three's plain
  class (a custom `copy` / `set` could throw or have effects), a source matrix without `elements`.
- Private (written one by one, the shipped statements): `{value}` objects with other keys (a `needsUpdate`
  would change three's upload and three's `cloneUniforms`), three `Uniform` instances, a Matrix0 aliased with
  the cloud source (it tracks the source live), the ±0 case above.
- The Gouraud walk is skipped only when the registry (element-wise), the epoch and the absence of
  userData-less members are unchanged since a walk that covered the registry: then every member already
  carries `g.epoch`, and the shipped walk would write nothing. With the registry one diff step on, only the
  joiners can carry another epoch. (A userData-less member is written every frame by the shipped walk with
  values that only change with the epoch; the skip is disabled while one exists anyway.)
- Another writer of a slot uniform must unbind first: cloud_volume's `__setCloudShadowStrength` calls
  `sharedUnbindCloudStrength()` before its loop; `CloudVolume.dispose()` releases the cloud slots.

### G1.3 Audit (every writer, reader, cloner; `rg` over scene3d/, plugins/, index.html, tools/, harness/)

- Writers of these names on registry materials: the four pushers; `__setCloudShadowStrength` (handled). Seeds:
  terrain.js's material literal; terrain_batch `_buildBatchMaterial` (key-by-key VALUE clones into fresh
  `{value}` objects; only TERRAIN_FX_LIGHT_UNIFORMS are shared by identity). Nothing else assigns `.value`,
  mutates a value in place (`.set/.copy/...` — only the pushers and far_terrain on its OWN materials), or
  replaces a `{value}` object; the VFX `shader.uniforms.uTime = g.uTime` hooks are MaterialCache materials.
  The live tuners (`__setTerrainMacro`, `__terrainMicro`, `__terrainRound`, `__waterFlow`,
  `__terrainFarSimplify`, volcano / obsidian knob overrides) write other uniforms (their knob tables checked).
- Readers: far_terrain `publishFarUniforms` (copies uSunDir / the Gouraud set by value from the first member),
  far_terrain `ensureBakeRig` (`src.clone()` → three `cloneUniforms` deep copy), terrain_snow / terrain_dirt
  / terrain_sand light copies (by value; terrain_dirt also reads `__acLightEpoch !== undefined`, unchanged by
  the skip), cloud_night diag, film tools: all read `.value` through the map.
- Per-material values that differ (NOT slots): uLbOriginXy, uVertexTypes, uMergeData, uTexMergeEnabled,
  uAcGouraudEnabled, uBakeAlbedo, uPaintLight.xyz (so uPaintLight stays a per-material `.w` write).
- Cloners / shallow copies: terrain_batch (by value), far_terrain (three clone); no `...x.uniforms`,
  `Object.assign` or `UniformsUtils.merge` of a terrain map anywhere.
- night_ramp.js is a value source only (sunGlint / paintNight / night ground scale / env scale), computed
  once per frame or light tick; it writes no uniform.
- Wiring checked: liveScene3d === the loop's scene3d === window.liveScene3d (index.js 4857, 5152), and the
  LRU and the stream baker mutate that object's array, so the pushers share one registry in production; the
  module works with different arrays per pusher too (each pusher keeps its own view).

Limits (documented in the module): a Proxy uniform or a `uniforms` getter (reads would happen fewer times); a
uniform replaced or added on a registry material by future code between registry changes
(`window.__terrainShared.verify()` reports a re-pointed slot); a uniform value aliased with another uniform of
the same material (terrain.js builds each with its own `new`).

### G1.4 Tests

`tests/hot_terrain_shared.test.mjs` — two instances each of loop.js and cloud_volume.js (REF flag off, GEN on),
lane F's flags forced the same in both (on, then off), one scripted RNG on two identically built worlds:

- [1] / [2] 1,200 + 900 frames, every material that ever existed compared after every step (7,267 + 5,464
  probes, 1,423 + 1,027 materials): values (Object.is per number, per component, texture identity — a three
  clone's texture by its shared Source), the `{value}` object's keys and `needsUpdate`, `userData.__acLightEpoch`,
  the far-ring copy, the snow light copy, three clones of members, which push threw (and the OddMatrix
  `copy()` count). Churn: bakes before / between / after the pushes, LRU evict (array reassignment), park /
  unpark, splice, mid-array insert, swap, duplicates and their removal, holes, an empty and a missing
  registry, batch-style clones; branches: breath on/off, sky state missing / NaN heading, epoch bumps, cloud
  shadows on / off / sunset, strength override / NaN / −0 / none, texture swaps, a source without elements,
  the strength setter, the RP3-skipped sun push, 50-frame indoor streaks; private kinds (three Uniform, extra
  keys, aliased source matrix, −0 values) and hazard kinds (frozen uniform, custom matrix, missing map,
  missing Gouraud colour, missing uEnvIntensity) baked in a hazard window.
- [3] the slots carried the pushes (6,873 incremental and 1,912 full group resyncs) and fell back exactly
  while hazards were registered; [4] after the registry empties nothing is bound and no uniform object is
  shared; [5] three r184's real WebGLRenderer over `tests/helpers/fake_webgl2.mjs`: the full GL call stream
  (every call, every argument, uniform values included) identical frame by frame over 90 frames with bakes
  and evictions; [7] joiners that arrived while the sun push wrote nothing are lit when it resumes (two diff
  steps → full walk); [8] indoors: evicted materials leave the cloud slots within 31 frames, values exact;
  [6] default OFF.
- Mutation check, run in a symlink mirror of the app (`--preserve-symlinks`: the live tree that serve.py
  hands out was never mutated). Each rule broken on purpose, the suite must fail — all 18 do: bind during
  classification (incremental and full pass), `gone()` re-check removed, joiners not classified, leavers not
  frozen (incremental and full), joiners-only two steps behind, Gouraud skip ignoring the version, if-diff
  always bound, alias check removed, `{value, needsUpdate}` treated as plain, time / cloud hazard fallback
  removed, sweep of unwritten groups removed, idle sweep removed, a frozen Vector3 / Matrix4 sharing the
  slot's value, the strength setter not unbinding. One survives by construction (the skip ignoring
  userData-less members is value-equivalent, see G1.2).
- Shipped suites over the touched files, flag off and forced on (preload `__setRustFlagForTest`):
  hot_terrain_push 4/4, cloud_night_lighting 75/75, cloud_shadow_cadence 55/55, retail_light_tick 22/22,
  environ_override 23/23.

### G1.5 Bench and estimate

`node tests/hot_terrain_shared.test.mjs --bench=off|on` (541 materials, ¾ per-LB literals and ¼ batch-style
dictionary-mode clones, lane F's two flags ON in both arms — the shipped default now): time + sun + cloud
pushes **124 → 5.2 µs/frame** (runs 182 / 124 / 118 vs 9.0 / 5.2 / 5.2; a second series after the idle sweep
landed: 125 / 349 / 185 vs 5.3 / 5.3 / 7.1). With a bake + an evict every 10th frame (the bench's material
construction included, both arms): 120–169 → 13–14 µs/frame. The registry-change frame itself: **98 → 31 µs**
(time 18.7 → 7.5, sun 31.8 → 12.5, cloud 48.0 → 11.4) — no spike above today's per-frame cost.

1070 [D]: the three pushes cost 0.132 ms/frame on 2026-10-23, ≈ 0.10 after lane F's flags (their node ratios);
the shared path's floor is three ~500-pointer compares and a few writes. **−0.09…−0.10 ms/frame**, plus
~0.013 if the IBL patch is applied.

### G1.6 For the orchestrator: the IBL push (ibl_environment.js, not my file)

`sharedPushIbl` is in the module and covered by [1]–[5] against a verbatim copy of the shipped loop. Wiring
(3 edits in `scene3d/ibl_environment.js`):

```js
// imports
import { rustFlag } from "./rust/scene_core.js";
import { sharedPushIbl, sharedReleaseIbl } from "./terrain_shared_uniforms.js";
let _hotTS;
const _hotTerrainSharedOn = () => (_hotTS === undefined ? (_hotTS = rustFlag("hotTerrainShared", false)) : _hotTS);

// IblEnvironment.tick, the terrain loop
    if (Array.isArray(terrainMaterials)) {
      const envI = Number.isFinite(p) ? p : 1.0;
      if (!(_hotTerrainSharedOn() && sharedPushIbl(terrainMaterials, this.envCubeTexture, envI))) {
        for (const mat of terrainMaterials) { /* the shipped loop, unchanged */ }
      }
    }

// IblEnvironment.dispose, first line
    if (_hotTerrainSharedOn()) sharedReleaseIbl();
```

## G2. weapon_fx `_syncDelta` (`?hotWeaponFxSync`)

`_syncDelta` mirrors each weapon clone's 19 surface fields from its base every frame with a VARIABLE key over
base materials of several classes (megamorphic keyed loads). The flag runs ONE generated function over the
frozen `MATERIAL_SURFACE_FIELDS`: per key, in the same order, `x = b.map; if (x !== s.map) { m.map = x;
s.map = x; prog = true; }` (the `_PROGRAM_FIELDS.has(k)` test resolved at generation — a module constant),
`"use strict"` like the module (a write a strict loop throws on throws here too; a sloppy `new Function` would
silently skip it). Compiled on first use; a CSP that forbids `new Function` leaves it null and the loop runs.

`tests/hot_weapon_fx_sync.test.mjs` — two module instances: [1] 90 records × 1,500 syncs over five material
classes with live changes (texture re-seats, fades, transparent, alphaTest across 0 — the accessor bumps
`version`, blending, depthWrite, colours, NaN metalness, −0 opacity), an own accessor on some bases read the
same number of times, every clone and snapshot identical after every sync (135,000 comparisons); [2] the
generated body is the shipped statement per key in order, `prog` exactly for the program fields, strict; [3]
a non-writable target throws in both with the same partial writes; [4] 40 real weapons through
`weaponFxBegin` / `weaponFxMaterial` / `tickWeaponFx` with live base changes and a cache-base adoption: every
clone and snapshot identical after each of 600 ticks; [5] default OFF. `test_weapon_fx.mjs` (the shipped
suite) passes with the flag off and forced on.

Bench (`--bench=off|on`, median of 3): `_syncDelta` over 80 records (5 % of bases changing per frame)
**122 → 28 µs** (121.7 / 134.6 / 121.0 vs 28.4 / 28.1 / 27.4); the whole `tickWeaponFx` for 40 real weapons
**71 → 24 µs** (the keyed mirror was most of the tick). 1070 [D]: `_syncDelta` 0.016 ms/frame self →
≈ 0.004, plus whatever of `_syncMaterials`' 0.018 is inlined mirror work (its ticks sit on its first line):
**−0.012…−0.02 ms/frame**. Mutation check: dropping `"use strict"`, the snapshot write, or the `prog` flag
each fails the suite.

## G3. GPU grass tile cull (`?hotGrassCull`)

`cullGrassTiles` (per ring per camera pass, in the ring mesh's onBeforeRender) asked `zRange` →
`terrain_field_gpu.heightRange` for every tile on every call, re-answering the same tiles frame after frame
(a ring window moves only when the player crosses one of its cells, the field only re-walks on an LB change
or an oracle change). The flag adds:

- `field.generation()` (terrain_field_gpu.js): a stamp bumped at the start of every walk and in `dispose()`,
  from one module-wide sequence (unique across fields). Everything `heightRange` reads — the slot arrays,
  the window centre, `disposed` — is mutated only inside a walk or `dispose()` (audited: `writeTile` is
  called only from `update`), so for a fixed stamp heightRange is a pure function of its rect.
- `createGrassZMemo()` per ring (terrain_grass.js `r.cull.zMemo`, `zGen` = the stamp): each tile's answer is
  kept until the stamp, the zRange function or the ring window (winMin, cell, ts, g, T — everything a tile
  rect depends on) moves. A null answer is kept as null; only NUMBER answers are cached (anything else is
  used as the shipped code uses it, one read of each field). The same arithmetic on the same operands
  (`zLo = min − 0.5`, `zHi = max + zAboveM` of THIS call).
- The frustum planes' coefficients read once per call (≤ 16 planes; more: per tile as shipped), the same
  tests in the same order with the same early exit.

`tests/hot_grass_cull.test.mjs`: [1] 6,000 culls over a real terrain field + oracle (walks on LB changes,
rebakes, evictions, no-op updates, three rings, frustums of random cameras as three Planes, arrays, lists
with holes and > 16 planes, discs, holes, eye positions, live margins): same count and the same `uGpTiles`
value slot by slot; [2] non-number answers: same survivors, same `valueOf` calls, nothing cached; [3] the
stamp moves on every walk and dispose, not on a no-op update, never repeats across fields; [4] the real GPU
grass provider (`createTerrainGrassProvider`, 4 rings at ultra) driven through each ring mesh's
onBeforeRender with the flag off for one provider and on for its twin, over 1,200 frames with player moves
across LBs, rebakes, `setLodLook` band changes and second passes: every ring's `uGpTiles` and `instanceCount`
identical; [5] default OFF. The shipped suites (`test_grass_gpu_place.mjs`, `test_terrain_field_gpu.mjs`,
`test_terrain_grass_gpu.mjs`) pass with the flag off and forced on.

Bench (`--bench=off|on`, the provider's four ultra rings, a camera sweeping while the player runs, median
of 3): the four ring culls **29.5 → 14.8 µs/frame** (29.5 / 30.2 / 29.5 vs 14.6 / 15.0 / 14.8); with the
provider's tick 48.9 → 30.6. 1070 [D]: cullGrassTiles 0.050 + heightRange 0.017 ms/frame → **≈ −0.03 ms/frame**.
Mutation check (7, all fail the suite): the memo ignoring the stamp or the window, caching non-numbers, a
cached null not honoured, a null plane taken as outside, no stamp bump on a walk or on dispose.
Not a Rust job: four calls a frame, each 64 tiles × ≤ 6 planes after the memo; a wasm crossing plus the
plane marshalling would cost about what remains.

## 3. The survey (1070, our code's self time per frame, by bucket)

Script: `tools/rust_parity/profile_systems.py` buckets + a per-function pass (the native leaves counted only
when OUR function called them directly). Owner in brackets when not this lane.

| Bucket (ms/frame) | Top self items (µs/frame) | Verdict |
|---|---|---|
| misc per-frame JS 1.11 | syncBatchMatVariants 243 [F1 done]; _tickPerFrameBody 117 (72 of it on `materialCache.tickAnimatedSurfaces` — materials.js); index.js tick 77 (58 on one line of the 10-23 index.js) [not mine]; _pushCloudShadowsToTerrain 66 / tickTerrainUTime 53 / tickTerrainSunDir 12.5 [G1]; static_batch_x _eachBucket 32, tickStatBatchXOptimize 16 [W]; loop `_harvestFogFence` getBufferSubData 28 (a GL readback: fixed); audio setListener 18; far_terrain assertRadiusPolicy 16 + apply 10; rejection_feedback get 15 [F: within noise]; night_ramp _search 13 + _params 10 [F7 + see §4]; ibl tick 14 [G1.6] | G1 |
| HUD 0.57 | vitals-orbs step 191 + getAnimations 109 [F3 done]; radar gatherCandidates 49 [F: entity index]; orb tick setAttribute 38 + wave 20 + frame 20 + tick 12 | orb residual inherent (§4) |
| post 0.62 | _collectParticlesOverClouds 65, _emitterOrigin 34 [A]; collectFxDistortSources 35 [A's closure]; index.js renders 14 + 13; fx_glow_effect update 13; particles_over_clouds collectLateFx 10; atmosphere_pipeline `_lateNow` 10 (+3.6 native) | timers lead (§4) |
| cells / lighting / camera / net 0.54 | occlusion_cull beginFrame getQueryParameter 59 (GL) + JS 16; cells tickCellVisibility3D 21, buildEnvCellsForLandblock URLSearchParams 18 + 13 [cells.js]; lighting writePoolSlot 10; pumpNetFrame 9 | GL calls fixed; cells.js not mine |
| our per-draw hooks 0.84 | async_link_guard renderBufferDirect 202, batched_runs 124 + _frameKey 85 + hook 67 + _prepare 38, skip_empty 36 [X2]; cullGrassTiles 50 + heightRange 17 [G3]; occlusion endQuery 43 + beginQuery 23 (GL) + onBeforeRender 11; runPerCamera 33; pinnedSampler 31.5, hbLightUbo 19, lightOnce 7, camTrack 6 | G3; §4 for the rest |
| our walk hooks 0.60 | skip_hidden_matrix updateMatrixWorld 374 [R4]; programSortStable 182 [F2 done] | not mine |
| (fx bucket) | weapon_fx _syncMaterials 18 + _syncDelta 16 + _tickOne 13 | G2 |

## 4. Looked at, not changed

| Item | 1070 self | Why not |
|---|---|---|
| occlusion_cull.js | JS 46 µs, GL 126 µs | The GL (getQueryParameter 59, endQuery 43, beginQuery 23) is the point of the feature and stays call for call. JS: merging beginFrame's third proxy walk into the first is exact but ~5 µs. |
| uniform_bind_patch.js pinnedSampler / hbLightUbo / lightOnce / camTrack | 31.5 / 19 / 7 / 6 µs | Wrapper overhead around three's private setters (get/setTextureUnits, the memo key reads); a cheaper exact form needs three's private `emptyTexture` (a fork). |
| batched_indirect_per_camera runPerCamera | 33 µs | WeakMap lookup + the id-prefix compare per call; a 64-bit compare (BigUint64Array) is exact but its V8 cost is uncertain, a hash is not exact (a missed upload). |
| vitals-orbs wave / tick / frame + setAttribute | 52 µs + 38 native | The phase advances every cadence tick, so every path string is new; no exact skip. |
| night_ramp residual | ~30 µs (after F7) | One native `location.search` read per reader call, ~10 calls a frame from other owners' per-frame code. Exact removal needs same-document URL-change detection (History / Navigation API hooks) that cannot be proven without a browser; or the callers read once per frame (their files). |
| terrain_oracle sample | 27 µs | Already allocation-free; a one-entry LB memo saves a Map.get (~5 µs). Its call count is lane E's scatter. |
| atmosphere_pipeline `_lateNow` | 10 + 3.6 µs for 4 `performance.now()` calls | Stats-only timers; dropping them changes `stats.collectMs / drawMs / cpuMsAvg` (diagnostics, not pixels) — the orchestrator's call. See the timer lead below. |

**Lead for the 1070 queue — timer reads.** Summed over the profiles, `performance.now()` wrappers and their native
leaves are ~85 µs/frame (entities tick `now` 11, `_lateNow` 14, `fxNowMs` 13, `_rp3NowMs` 11, animated_scenery
`_nowMs` 7, vitals-orbs `timelineNow` 3.6, blood_decals 5, wasm `__wbg_now` 4, …) — e.g. ~3 µs per call for
`_lateNow`, far above the usual ~50 ns. If a console loop confirms a slow clock on that box (QPC through a
hypervisor), the stats-only and duplicate per-frame reads are a ~0.05–0.08 ms lever; value-carrying reads
(budget gates, FX clocks) would need one stamp per frame, which changes values (not exact).

**Finding for lane F (batched_material_variant.js, not my file):** `_genMirror` builds its function with
`new Function` and no `"use strict"`, while the `_mirror` it replaces is strict module code: a write to a
non-writable or getter-only variant property throws in `_mirror` and is silently skipped by the generated
mirror. Unlikely on three materials, but a one-line exactness fix: prefix the body with `"use strict";\n`.

## 5. Flags (rows for docs/url-flags.md — the orchestrator adds them)

| `hotTerrainShared` | `on`/`1`/`true`/`yes` opts in; `off`/`0`/`false`/`no` | **OFF** (2026-10-26, lane F2) | `scene3d/loop.js` `_hotTerrainSharedOn` and `scene3d/cloud_volume.js` `hotTerrainSharedOn` = `rustFlag("hotTerrainShared", false)` | **One shared `{value}` per frame-constant terrain uniform.** tickTerrainUTime (uTime, uCrackGlowBreath), tickTerrainSunDir (uSunDir) and _pushCloudShadowsToTerrain (uCloudShadowEnabled / Map / Matrix0 / Strength) write one slot the registry's materials point at — bound lazily at a push, frozen to a private copy when they leave, idle pushers swept — and the Gouraud epoch walk runs only when the registry or the light epoch moved. Every material's value equal to the per-material loops' at every moment; anything those loops would throw on sends the push back to them (`tests/hot_terrain_shared.test.mjs`: 2,100 frames, 12,731 probes over every material ever made, the GL call stream through three r184 identical, 18 rule-break mutations caught). Node, 541 materials: 124 → 5.2 µs/frame (registry-change frames 98 → 31); 1070 ≈ −0.09 ms/frame [D]. `window.__terrainShared.{stats,verify}`. docs/2026-10-26-rust-hotspots-2.md §G1 | scene3d/terrain_shared_uniforms.js, scene3d/loop.js, scene3d/cloud_volume.js |
| `hotWeaponFxSync` | same grammar | **OFF** (2026-10-26, lane F2) | `scene3d/vfx/weapon_fx.js` `_hotWfxSyncOn` = `rustFlag("hotWeaponFxSync", false)` | **Generated mirror for the weapon clones' surface fields.** `_syncDelta` runs one compiled straight-line strict function over the frozen MATERIAL_SURFACE_FIELDS (named access, the shipped statement per key in order) instead of keyed loads that are megamorphic over five material classes; null under a CSP → the loop. `tests/hot_weapon_fx_sync.test.mjs`: 135,000 record comparisons + 40 real weapons × 600 ticks identical. Node: _syncDelta 122 → 28 µs per 80 records, tickWeaponFx 71 → 24 µs per 40 weapons; 1070 ≈ −0.012…−0.02 ms/frame [D]. docs/2026-10-26-rust-hotspots-2.md §G2 | scene3d/vfx/weapon_fx.js |
| `hotGrassCull` | same grammar | **OFF** (2026-10-26, lane F2) | `scene3d/grass_gpu_place.js` `hotGrassCullEnabled` = `rustFlag("hotGrassCull", false)` | **GPU grass tile cull with a per-ring height memo.** Each tile's `heightRange` answer is kept until the terrain field's `generation()` stamp (bumped by every walk and dispose, unique across fields) or the ring window moves; the frustum planes are read once per call. Same survivors in the same order (`tests/hot_grass_cull.test.mjs`: 6,000 culls over a walking field + the real provider's four rings × 1,200 frames). Node: four ring culls 29.5 → 14.8 µs/frame; 1070 ≈ −0.03 ms/frame [D]. docs/2026-10-26-rust-hotspots-2.md §G3 | scene3d/grass_gpu_place.js, scene3d/terrain_field_gpu.js, scene3d/terrain_grass.js |

## 6. Verification (targeted, one at a time)

```
cd apps/holtburger-web
node tests/hot_terrain_shared.test.mjs        # G1 identity (8 checks, ~60 s on the laptop)
node tests/hot_terrain_shared.test.mjs --bench=off; node tests/hot_terrain_shared.test.mjs --bench=on
node tests/hot_weapon_fx_sync.test.mjs        # G2
node tests/hot_weapon_fx_sync.test.mjs --bench=off; node tests/hot_weapon_fx_sync.test.mjs --bench=on
node tests/hot_grass_cull.test.mjs            # G3
node tests/hot_grass_cull.test.mjs --bench=off; node tests/hot_grass_cull.test.mjs --bench=on
# shipped suites over the same files (flag off, then with a preload forcing the three flags on):
node tests/hot_terrain_push.test.mjs; node tests/cloud_night_lighting.test.mjs; node tests/cloud_shadow_cadence.test.mjs
node tests/retail_light_tick.test.mjs; node tests/environ_override.test.mjs
node test_weapon_fx.mjs; node test_grass_gpu_place.mjs; node test_terrain_field_gpu.mjs; node test_terrain_grass_gpu.mjs
```

Gate entries (harness/run-js-headless.mjs is the orchestrator's):

```js
  // 2026-10-26 lane F2 hot spots (docs/2026-10-26-rust-hotspots-2.md): flag off vs on.
  { tier: 5, flag: "hotTerrainShared", file: "tests/hot_terrain_shared.test.mjs" },
  { tier: 5, flag: "hotWeaponFxSync", file: "tests/hot_weapon_fx_sync.test.mjs" },
  { tier: 5, flag: "hotGrassCull", file: "tests/hot_grass_cull.test.mjs" },
```

index.html: nothing left to do. The one new module, `scene3d/terrain_shared_uniforms.js` (a static import of
loop.js and cloud_volume.js), is already in the boot modulepreload block from the orchestrator's 15:11 regen
(`node scripts/gen-modulepreload.mjs --check`: up to date, 457 modules).

## 7. Risks

- G1 re-points registry materials' uniform objects. Code that captures a terrain `{value}` object (not the
  map) and keeps it would stop seeing pushes after a leave/rejoin; none does today (§G1.3). Code that adds a
  new per-material writer of a slot uniform must unbind first (the module header says how).
- G1's exactness rests on terrain materials having no onBeforeCompile that replaces the uniform map; a future
  hook must keep `shader.uniforms` the material's map (three's own convention), or skip the flag.
- G2 compiles code from strings (like F1); a CSP without `unsafe-eval` falls back to the loop.
- G3 assumes `heightRange` stays a pure function of the field's walk state; a new field mutator must bump
  `generation()`.
