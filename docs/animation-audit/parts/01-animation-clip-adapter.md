I have everything I need. Producing the structured audit.

---

# Audit: `scene3d/animation.js` — the keyframe→clip adapter & AnimationCache

**Scope:** `external/holtburger/apps/holtburger-web/scene3d/animation.js` (1035 lines). Its sole importer is `entities.js:479` (`import { AnimationCache, cycleTimeScale, hasRootMotion } from "./animation.js"`). `buildAnimationClip` is *not* imported by production code — only by tests (`test_phase7_4a_animation_clip.mjs`, `test_phase7_4b_entity_pipeline.mjs`) — it is reached at runtime only through `AnimationCache.get`.

## What exists

`animation.js` exposes four surfaces, all stateless except the cache:

| Symbol | Lines | Role |
|---|---|---|
| `buildAnimationClip(animData, partNames)` | 63–225 | Flat wasm keyframe buffer → one `THREE.AnimationClip` with `2 × partCount` tracks |
| `cycleTimeScale(actualSpeed, baseSpeed)` | 269–281 | Pure anti-ice-skating playback-rate factor, clamped `[0.25, 4.0]` |
| `hasRootMotion(net)` | 297–304 | Pure predicate over a 7-vec net root displacement |
| `class AnimationCache` | 318–1035 | Memoized wasm-fetch + clip-build + mesh-conversion + hook-decode, keyed by `(setup, mt, motion, stance)` (+ suffixes), with LRU eviction and batch prewarm |

It is, by its own header comment (lines 1–3), a *"RAW keyframe → THREE.AnimationClip adapter… Sister to scene3d/adapter.js."* It is a **clip factory and asset cache** — it produces inert data and hands it to `entities.js`, which owns all motion behavior.

## How it works (file:line)

### `buildAnimationClip` — the flattener (63–225)
- Stride is hardcoded at `FLOATS_PER_PART_PER_FRAME = 7` (3 pos + 4 quat), `animation.js:38`, with layout `[(x,y,z,qw,qx,qy,qz) per part] per frame` validated against `numFrames*partCount*7` (`:92–98`).
- `numFrames === 0` → returns `null` ("caller renders rest pose only", `:83–86`); `framerate <= 0` with no `frameTimes` → also `null` (`:125–128`).
- **Timing** (`:114–134`): prefers a wasm-supplied per-frame `frameTimes` array; falls back to uniform `f/framerate`. The comment (`:100–113`) explains *why*: a `MotionData` chains **multiple `AnimData`** ("≈23% of retail… windup→strike→recover→settle", "≈22% are negative = reverse playback"), each with its own rate and sign, so a single uniform rate cannot represent the clip. The wasm side concatenates segments (`build_concatenated_motion_frames`) and emits cumulative times.
- **Root motion** (`:143–161`): if `posFrames` (length `numFrames*3`) is present, the per-frame whole-object translation is added to **every part's** position keyframe ("a lunge steps forward, a door swings open"). Fail-soft to no offset on wrong length.
- **Quaternion reorder** (`:162–171`): AC `(qw,qx,qy,qz)` → three.js `(qx,qy,qz,qw)`.
- **`InterpolateDiscrete` is mandatory** on both tracks (`:195–210`), with two stacked guard comments (`:174–194`): AC bakes every frame as an explicit key at 30 Hz and snaps via `floor(frame_number)` (cites PhatSDK `PartArray.cpp:56-59`); and the discrete flag is now *load-bearing* for the non-uniform `frameTimes` — linear/SLERP across uneven segment boundaries would re-introduce decoherence.
- **Duration** (`:216–224`): prefers wasm `duration`, else `numFrames/framerate`, else last frame time.

### `cycleTimeScale` (269–281)
Pure: `clamp(|actual|/base, 0.25, 4.0)`, with `base <= 1e-4` or non-finite → `1.0` no-op. The doc (`:228–267`) explains it mirrors retail `AnimData.Framerate = base * speed` / `apply_run_to_command`, and is consumed via `setEffectiveTimeScale` in `entities.js` — **the function is pure and does nothing on its own.**

### `hasRootMotion` (297–304)
Pure: true if translation magnitude `> 1e-4` m or rotation angle `2·acos(min(1,|qw|)) > 1e-3` rad; `null`/wrong-length → false.

### `AnimationCache` (318–1035)
- **Value shape** (returned by `get`, `:776–798`): `{ clip, partGroups, partMeshes:[], partCount, framerate, resolvedStance, restOrigins, restOrientations, hooks, rootMotionNet }`. So the "animation cache" actually carries **geometry, rest pose, decoded hooks, and root-motion vectors** — far more than clips.
- **Keys** (`:400–402`, `:478–506`): base `${setup}:${mt}:${motion}:${stance}`, plus optional `:sub:<fnv>` substitution suffix (`_substitutionSuffix`, `:424–444`), `:pl:<id>` placement suffix, and `:link:<fromMotion>` link suffix. Key cardinality multiplies across all four.
- **LRU** (`:347`, `:508–516`, `:850–871`): `Map` insertion-order, move-to-tail on hit, evict from head skipping in-flight (`pendingStartTimes`) entries; cap default 256 (`:350`, overridable via `?animCacheMax`).
- **`get`** also: stashes `part_N` names per setup (`:544–548`), drains+converts wasm meshes to three.js geometry via `meshToGeometryGroups` once per entry to fix a free()-race (`:559–594`), and **decodes ~25 hook types field-by-field into POJOs** (`:701–774`).
- **`getBatch`** (`:929–1019`): prewarms the wasm `shards` cache for a set of setupIds in one round-trip, with in-flight coalescing.

## Fragility & workarounds

1. **It's a clip factory, so the "sequence" is frozen at bake time.** Retail's multi-`AnimData` chaining (links → windup→strike→recover) is resolved *wasm-side* and **concatenated into one monolithic `AnimationClip`** (`:100–113`, `:646–668`). At runtime there is no sequence, no `curr_anim`, no `frame_number`, no links table — just a flat clip fed to a crossfade engine. Any per-segment decision (interrupt at strike, branch on a link) is impossible after the bake.

2. **`InterpolateDiscrete` is fighting the host engine.** The two guard blocks (`:174–194`, `:185–194`) exist because `THREE.AnimationMixer` is an interpolating crossfade/weight-blend engine, and AC needs the opposite (snap to authored key). The module disables the mixer's headline feature to emulate `floor(frame_number)`. The mixer's *other* headline feature, crossfade, is one `entities.js` itself documents retail **never had** (`entities.js:1326`: *"retail AC never crossfaded between motions"*). So the chosen engine provides two features: one is disabled here, the other is inauthentic — the mixer is nearly vestigial, a glorified discrete per-frame sampler.

3. **Two parallel root-motion mechanisms.** `buildAnimationClip` bakes `posFrames` onto *every part's* position track (`:143–161`) — a hack to translate the rig because there is no object-anchor authority. Separately, `rootMotionNet` (`:622–627`) is applied by `entities.js:8272–8277` (`_armRootMotionOnFinish`) to the entity **anchor** on overlay completion under `?rootMotionObject=1`. Retail does this *once* via `CSequence::apply_physics` accumulating `pos_frames` per frame into the object `Frame`. Here it's split into two flag-gated code paths in two files.

4. **Speed scaling is split and heuristic.** `cycleTimeScale` is pure here, but its inputs and application live in `entities.js` (call site `entities.js:10337`), gated behind `?velScale`, fed by EMA-smoothed speed (`:1405` region) and `setEffectiveTimeScale`. Retail folds speed into the framerate *at sequence-build time* (`operator*(AnimData, speed_mod)` → `acclient.c:341051`), so it's intrinsic to playback, not a post-hoc multiplier with clamps and EMA.

5. **Cache-key explosion forced the LRU.** The W7.5 substitution suffix (`:405–423`) multiplies entries by equip-variant; W7.6 added eviction (`:318` constructor comment) to contain it. Retail keys motion by `(style<<16 | substate)` in a *shared immutable* `CMotionTable.cycles` map (one table, all objects) — equips never multiply motion entries because appearance is orthogonal to motion data. Here, baking equip into the clip key conflates the two.

6. **The cache is a hook courier, not a hook authority.** `get` decodes 25+ hook types into POJOs with a 70-line hand-written field copy (`:701–769`), then `entities.js` re-implements the per-frame firing loop (`_fireHook` at `entities.js:11035`, `_tickAnimationHooks` at `:10894`) by *searching `mixer.time` windows* (`planHookWindows`). animation.js knows the entire hook schema but executes nothing; entities.js reconstructs retail's frame-crossing dispatch outside the clip.

7. **Concern bleed.** A geometry free()-race fix (`:26–34`, `:559–594`) put **mesh→BufferGeometry conversion** inside the *animation* cache. The module now owns clips, geometry, rest pose, hooks, and root motion — but no motion behavior.

8. **Dense date-stamped patch archaeology.** T3/T4/T11/Cohere-B/Wave 7.5/7.6/A5-P3/F.40/FU3 tags throughout (`:100`, `:174`, `:227`, `:283`, `:306`, `:405`, `:646`) each mark an independent band-aid layered onto the same flat-clip model — the "piecemeal" symptom the audit targets.

## Retail (acclient) comparison

Retail has **one** interpreter, applied to every animated object (players, monsters, doors) via per-object state over a shared table:

- **`CMotionTable`** (`acclient.h:31654`): immutable, shared. Hash tables `cycles` (`(style<<16|substate) → MotionData`), `modifiers`, `links`, `style_defaults`.
- **`CMotionTable::GetObjectSequence`** (`acclient.c:337641`, via `DoObjectMotion` `:339023`, `SetDefaultState` `:337970`): resolves a `motion` command + per-object `MotionState` into an ordered chain by walking cycles + links, emitting `*num_anims` and calling `add_motion` repeatedly.
- **`CSequence`** (`acclient.h:30747`): per-object queue — `DLList<AnimSequenceNode> anim_list`, `first_cyclic`, `velocity`, `omega`, `frame_number`, `curr_anim`. Each `AnimSequenceNode` (`acclient.h:31063`) is `{anim, framerate, low_frame, high_frame}`.
- **`CSequence::update_internal`** (`acclient.c:340659`): the real per-frame loop. `frame_quantum = framerate * quantum`; on each integer frame crossed it accumulates `pos_frames` into the object Frame (`Frame::combine`), calls `apply_physics` for velocity, and calls `execute_hooks`. At segment end, `advance_to_next_animation` carries the time remainder into the next `AnimData`.
- **`CSequence::execute_hooks`** (`acclient.c:339683`): walks the frame's `CAnimHook` list, honors direction, queues each to the object — the per-frame hook dispatch that `entities.js` reconstructs by window-searching mixer time.
- **Speed**: `operator*(AnimData, speed_mod)` (`acclient.c:341051`) bakes `framerate *= speed_mod` at build time; `CMotionInterp::apply_run_to_command` / `get_state_velocity` (`acclient.c:343439` / `:343539`) supply the factor.

**Mapping to holtburger:** `animation.js` corresponds to **none** of the interpreter — it sits where AC has `add_motion`+`CSequence` build, but instead of producing a *playable sequence with a runtime cursor* it produces a *frozen `AnimationClip`*. The interpreter's three jobs — (a) resolve `motion`→sequence at runtime (`GetObjectSequence`), (b) advance `frame_number` and cross frames (`update_internal`), (c) fire per-frame hooks + accumulate root motion (`execute_hooks`/`apply_physics`) — are scattered: (a) is pre-baked wasm-side and discarded, (b) is delegated to `THREE.AnimationMixer.update` (`entities.js:3280`, tick at `:418`), (c) is hand-rolled across `entities.js` (`_tickAnimationHooks`, `_armRootMotionOnFinish`). There is no `CSequence` equivalent anywhere — that is the structural gap.

## Consolidation recommendations

**Could animation.js host a real motion interpreter instead of a dumb clip factory? Yes — it is the correct home, but its current output type blocks it.**

It is already the single chokepoint between wasm keyframe data and the renderer (sole importer `entities.js:479`), and it already caches everything an interpreter needs per `(setup, mt, motion, stance)`: framerate, `frameTimes`, `duration`, hooks, rest pose, `rootMotionNet`, and the segment-concatenated frames. The only thing it throws away is the **sequence structure** — it concatenates segments and emits one clip.

To become the motion authority (`CMotionInterp`/`CSequence` analog), in order of leverage:

1. **Stop flattening; emit a sequence, not a clip.** Have the wasm bake return the `AnimData` chain (`anim_id, low_frame, high_frame, framerate, sign` per segment) instead of a pre-concatenated buffer. animation.js owns a tiny `MotionSequence` object per playing entity with `frameNumber` + `currAnim` cursor — a direct `CSequence` (`acclient.h:30747`) port. The InterpolateDiscrete machinery (`:174–210`) becomes trivial: per-frame pose is an index lookup (`floor(frameNumber)`), no `KeyframeTrack`/mixer needed.

2. **Own a single `advance(entity, dt)` tick.** Port `CSequence::update_internal` (`acclient.c:340659`): step `frameNumber += framerate*dt`, cross integer frames, fire hooks at each boundary (folding in the already-decoded hook POJOs from `:701–774`), and at segment end carry the remainder to the next `AnimData`. This replaces `THREE.AnimationMixer.update` + `_tickAnimationHooks`'s `planHookWindows` window search — the mixer can be retired for skeletal pose.

3. **Fold speed into the sequence at build time.** Apply `cycleTimeScale` by multiplying each segment's framerate (retail `operator*`, `acclient.c:341051`) inside the sequence builder, deleting the EMA + `setEffectiveTimeScale` + `?velScale` plumbing in `entities.js` (`:10337`).

4. **Unify root motion in one place.** Accumulate `posFrames` per frame into a single object anchor during `advance` (retail `apply_physics`), eliminating both the bake-onto-every-part hack (`:143–161`) and the separate `_armRootMotionOnFinish`/`hasRootMotion` path (`entities.js:8272`).

5. **Expose retail's entry points.** `doObjectMotion(entity, motion, state)` / `stopObjectMotion` / `setDefaultState` that resolve cycles+links at call time — collapsing `setMotion` / `setSwingMotion` / `setStance` / `_tryPlayLink` / the jump tweens into one dispatcher, and naturally fixing the audit's headline bugs (upper-body-only swings, animation-less missiles, independently-breaking door/death) because each becomes the *same* sequence resolution, not a bespoke code path.

6. **Collapse the cache-key explosion.** With motion data separated from appearance, cache the resolved `AnimData` chains by `(mt, motion, stance)` like retail's shared `cycles` map; substitutions then key only geometry/palette (`partGroups`), not motion — removing the `:sub:` suffix multiplier (`:405–444`) and the LRU pressure it created.

**Net:** animation.js is well-positioned to *be* the interpreter — it has the data and the chokepoint position — but today it commits the one fatal simplification (sequence → flat clip) that forces every downstream consumer to re-invent frame stepping, hook firing, speed scaling, and root motion ad-hoc. Replacing its return type from `THREE.AnimationClip` to a `CSequence`-style cursor, and moving the per-frame tick here, is the single change that turns scattered motion logic into one authority.
