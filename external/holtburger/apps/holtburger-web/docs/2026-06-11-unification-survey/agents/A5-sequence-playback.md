# A5 sequence-playback — unification survey

Scope (per §5): per-frame animation playback + hook dispatch + part-frame application into the
rig. Queue/completion ownership (pending_animations, AnimationDone→MotionDone) is A4's seam —
referenced where the boundary leaks, not re-surveyed.

## 1. Retail map

Retail runs ONE sequence machine, clocked by the physics quantum, whose output is simultaneously
(a) the rig pose, (b) the object's animation-driven translation/rotation, and (c) the hook stream.

Call order (per physics update of one object):

1. `CPhysicsObj::UpdatePositionInternal(quantum)` builds an identity `offset_frame`, then calls
   `CPartArray::Update(quantum, &offset_frame)` (acclient.c:320013), which is a pure forward to
   `CSequence::update` (acclient.c:325140-325143).
2. `CSequence::update` (acclient.c:340951-340965): if `anim_list` non-empty →
   `update_internal(quantum, &curr_anim, &frame_number, retval)` then `apricot()` (trim completed
   one-shot nodes ahead of `curr_anim`/`first_cyclic`, acclient.c:339893-339945); if empty →
   `apply_physics(retval, quantum, quantum)` (pure sequence velocity/omega integration,
   acclient.c:340961-340964).
3. `CSequence::update_internal` (acclient.c:340659-340780):
   - `frame_quantum = framerate * quantum`; `frame_number += frame_quantum` (340688-340696).
   - Forward path: clamp at `high_frame` and compute `time_left` for the spill
     (340697-340711); then **for every integer frame crossed**: combine the per-frame
     `pos_frames` AFrame into `retval` (`Frame::combine`, 340717-340720), apply sequence
     velocity/omega scaled `1/framerate` (`apply_physics`, 340722-340723), and
     `execute_hooks(part_frame[fn], dir=+1)` (340725-340726). Backward path mirrors with
     `Frame::subtract1` and `dir=-1` (340746-340759).
   - On segment exhaustion (`advance_anim`): queue `anim_done_hook` via
     `CPhysicsObj::add_anim_hook` IF the finished node is not the head==first_cyclic
     (340764-340773), then `advance_to_next_animation` (340775) and loop with the spill
     `quantum = time_left` (340776) — multiple segments can elapse in one update with exact
     time accounting.
4. `CSequence::advance_to_next_animation` (acclient.c:340473-340587): next node or wrap to
   `first_cyclic` (340563-340566); `frame_number = get_starting_frame(next)` — which is
   `high_frame + 1 − 0.0002` for negative framerate (acclient.c:341016-341025). Boundary
   pos-frame add/subtract keeps root motion continuous across segments (340549-340575).
5. `CSequence::execute_hooks` (acclient.c:339683-339699): for each `CAnimHook` on the crossed
   AnimFrame, fire iff `direction_ == 0 || dir == direction_`, by QUEUEING onto
   `CPhysicsObj::anim_hooks` via `add_anim_hook` (339696, 322063-322073). Hooks do NOT run
   inline.
6. Back in `UpdatePositionInternal`: the accumulated `offset_frame` translation is scaled by
   `m_scale` when `transient_state & 2` (CONTACT) else ZEROED (acclient.c:320014-320026), passed
   through `PositionManager::adjust_offset` (320028-320030), combined into the object's new frame
   (320031), physics-resolved (320034), and ONLY THEN `CPhysicsObj::process_hooks` drains the
   queued hook array in order — frame hooks and `anim_done_hook` interleaved as queued —
   calling each hook's virtual `Execute` (acclient.c:320035, 318641-318688).
7. Rig application: after position resolve, `CPartArray::SetFrame` →
   `CPartArray::UpdateParts(frame)` takes `CSequence::get_curr_animframe()` — `curr_anim`'s
   part-frame at `floor(frame_number)` (acclient.c:339745-339763, snap at 339756) or the
   `placement_frame` when no anims — and per part `i < min(num_parts, animframe.num_parts)`
   does `Frame::combine(&parts[i]->pos.frame, objFrame, &animframe->frame[i], &scale)`
   (acclient.c:326601-326632, clamp 326615-326617, combine 326624; SetFrame forward 326766-326772).

Speed/direction control: `MotionTableManager::add_motion` sets sequence velocity/omega from the
authored `MotionData` and scales node framerates by the motion's speed (acclient.c:337445-337466);
`multiply_cyclic_animation_fr` re-rates all cyclic nodes at runtime, and a NEGATIVE multiplier
swaps `low_frame`/`high_frame` to reverse playback in place (acclient.c:339736-339742,
340968-340979; called with 0.0/multiplier at 337276-337281). `apply_physics` integrates the
sequence's velocity and omega into the offset frame (acclient.c:339860-339890).

## 2. Ours map

Architecture: there is NO live CSequence. The Rust/wasm side BAKES a whole resolved motion cycle
(all `MotionData.anims` segments, low/high clipped, reverse segments re-ordered forward) into a
flat keyframe payload once per cache key; JS plays it on a `THREE.AnimationMixer`.

| concern | Rust (wasm) | JS (scene3d) |
|---|---|---|
| segment chain + frame bake | `build_concatenated_motion_frames`, apps/holtburger-web/src/lib.rs:5681-5873 (per-segment dt 5748-5754, low/high clip 5737-5746, reverse re-order 5821-5856) | clip build `buildAnimationClip`, scene3d/animation.js:63-225 |
| frame snap semantics | — | `THREE.InterpolateDiscrete` on both tracks, animation.js:195-210 |
| per-frame times / duration | cumulative `frame_times` + `duration`, lib.rs:5854-5872 | consumed animation.js:114-134, 216-223 |
| root motion (pos_frames) | cumulative accumulator; `DIM5_2_ROOT_ORIENT=true` folds rigid (R,T) into every part's keyframe, lib.rs:5703-5819 (gate const lib.rs:5624) | additive fallback adds posFrames to every part track, animation.js:143-161 |
| playback clock | none | `inst.mixer.update(dt)` per entity per rAF, scene3d/entities.js:8995; driven from loop.js:1544 (`entityManager.tick(dt)`) |
| playback rate | `state_ground_speed` getter (final m/s) | `cycleTimeScale(actual, base)` clamp [0.25,4.0], animation.js:269-281; applied via `setEffectiveTimeScale`, entities.js:6127 |
| hook bake | hooks carried per baked frame; reverse segments NEGATE hook direction at bake, lib.rs:5825-5852 | timeline snapshot sorted-by-time, animation.js:644-728; stashed per action `inst.hookTimelines`, entities.js:1721, 2890, 5346, 6044, 7415 |
| hook clock + dispatch | none | `_tickAnimationHooks` window `(lastTime, currentTime]` on `action.time`, entities.js:9454-9523; per-type dispatch `_fireHook` (≈26 hookTypes incl. 1-26), entities.js:9531-10100; direction gate `=== -1` drop, entities.js:9565 |
| hook side-effect clocks | none | wall-clock tweens: `_tickSwingTween`/`_tickJumpPoseTween`/`_tickCastTween`/`_tickScaleHookTween` use `performance.now()` (entities.js:9024-9078), `_tickHookOmega`/`_tickMaterialHooks` use dt (entities.js:9095, 9117) |
| one-shot vs cyclic | — | LoopRepeat cycle action + LoopOnce overlay actions with weights/crossfades (entities.js:2878, 5349-5365, 7397; mixer `finished` listeners 7506-7516) |
| rest pose / placement frame | `restOrigins`/`restOrientations` per part | applied at spawn, animation.js:445-452 (consumed in entities.js rig build) |

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | Playback clock: single physics-quantum-stepped `frame_number` inside the object update vs three.js mixer time advanced by JS rAF dt, decoupled from the Rust tick | acclient.c:340951-340965, 320013 | entities.js:8995; loop.js:1544 | DIFF-ALGO (architectural) | rig can lead/lag physics by up to one rAF; exact multi-segment time spill (`time_left`, 340702-340708/340776) replaced by mixer interpolation | partially — DESIGN.md Stage 2 ties rig to interpreted state for the LOCAL player only |
| 2 | Root motion feeds the OBJECT: pos_frames → offset_frame → scale by m_scale, ZEROED unless `transient_state & 2` (contact), → PositionManager → object frame + physics | acclient.c:340717-340720, 320014-320031 | lib.rs:5762-5819; animation.js:143-161 | DIFF-ALGO | ours is purely visual (folded into part keyframes); object/collision anchor never moves, no contact gate, no PositionManager involvement — lunges/knockbacks translate the rig while the physics position stays, then snaps on next server pos | partial — G10 claims visual wiring "no gaps"; DIM5-2 shipped (orient fold, lib.rs:5624 const=true); object-motion side untracked |
| 3 | Final-frame hooks on completed one-shots: retail clamps `frame_number` to `high_frame` and fires every crossed frame's hooks in the same update before queueing anim_done | acclient.c:340697-340727, 340764-340774 | entities.js:9470 (`if (!action \|\| !action.isRunning()) continue;`) | MISSING (edge) | a LoopOnce action finishing between two rAFs drops all hooks in `(lastHookTime, duration]` — end-of-swing sounds, door-closed thunks, last-frame particle/material hooks intermittently never fire | untracked |
| 4 | Hook execution deferral: retail QUEUES hooks (`add_anim_hook`) and drains them once per update AFTER position resolve via `process_hooks`; anim_done is interleaved in the same queue preserving order | acclient.c:339696, 322063-322073, 320035, 318641-318688 | entities.js:9490-9521 (inline fire during entity tick); completion via mixer `finished` events, entities.js:7506-7516 | DIFF-ALGO | ours fires hooks inline mid-tick and `finished` fires inside `mixer.update` (entities.js:8995) BEFORE `_tickAnimationHooks` (entities.js:9009) — completion handlers can run before that frame's hooks, inverting retail order (compounds #3) | untracked (completion routing itself = A4 seam) |
| 5 | Runtime framerate mutation: `multiply_cyclic_animation_fr` re-rates live cyclic nodes; NEGATIVE multiplier swaps low/high to reverse playback in place | acclient.c:340968-340979, 337276-337281, 339736-339742 | animation.js:269-281 (clamp [0.25,4.0]); reverse only at bake time, lib.rs:5821-5856 | DIFF-ALGO | positive scaling ≈ parity via setEffectiveTimeScale; runtime reversal (and rate 0.0 freeze, 337276) unrepresentable without a re-bake; clamp 0.25 floor also forbids retail's 0.0 stop | partial — DESIGN.md Stage 2 (speed_mod contract); reverse/freeze untracked |
| 6 | Sequence physics (velocity/omega) as ONE owner: retail stores them ON the sequence and `apply_physics` integrates both into the same offset frame each crossed frame | acclient.c:337445-337466, 339860-339890, 340722-340723 | split: rate via `cycleTimeScale` (animation.js:269-281, entities.js:6127); translation via movement pipeline (DESIGN.md Stage 1/2); omega via `_tickHookOmega` (entities.js:9095) | SPLIT-BRAIN (3 sites) | three clock/owner domains for what retail computes in one place; remote entities have no sequence-velocity tie at all | DESIGN.md Stage 2 (local rig tie); G12 (velocity collapsed to scalar magnitude) |
| 7 | One-shot composition: retail's single-track queue — a one-shot REPLACES the pose until done (apricot trims it; wrap to first_cyclic) — vs our weighted LoopOnce overlays blended over the locomotion cycle | acclient.c:340590-340644 (append/first_cyclic), 339893-339945 (apricot), 340563-340566 (wrap) | entities.js:5349-5365, 7397, 2878 (overlay + crossfade machinery) | EXTRA | three.js blends poses across two actions that retail never co-played; can look better (upper/lower body mix) but is non-retail and the weight scheduling is bespoke per call site | untracked as a divergence (overlay design intentional per swing-classification work) |
| 8 | Hook side-effect clocks: retail = one quantum for everything; ours = mixer dt for hooks/omega/material ramps but `performance.now()` wall-clock for swing/jump/cast/scale tweens | acclient.c:340659-340780 (single quantum) | entities.js:9024-9078 (performance.now tweens) vs 9095/9117 (dt) | SPLIT-BRAIN (2 clock domains) | tab-throttle/pause desyncs wall-clock tweens from dt-driven mixer state; slow-mo or dt clamping diverges the two families | untracked |
| 9 | Frame snap: retail samples part frames at `floor(frame_number)`, never interpolating | acclient.c:339756, 326611-326624 | animation.js:195-210 (`InterpolateDiscrete` both tracks, load-bearing comment) | PARITY | — | Cohere-B shipped 2026-05-12 |
| 10 | Hook direction gate incl. reverse segments | acclient.c:339694-339695 | entities.js:9565 + bake-side negation lib.rs:5825-5852 | PARITY (by construction) | — | Issue B 2026-06-03 / DIM3-4 shipped |
| 11 | Multi-segment chaining, low/high clipping, per-segment dt + cumulative times, boundary pos-frame continuity | acclient.c:340473-340587, 340688-340711 | lib.rs:5681-5873; animation.js:114-134 | PARITY (baked equivalent) | — | T3/T4 2026-06-02; G10 "no gaps" |
| 12 | Part-count clamp on apply: retail tolerates `animframe.num_parts != num_parts` via min() | acclient.c:326615-326617 | animation.js:87-91 (throws on partNames/partCount mismatch) | DIFF-ALGO (minor) | a Setup whose anim has fewer parts than the rig hard-fails the clip build instead of animating the prefix | untracked |

## 4. Staged unification plan

The bake-then-mixer architecture is a deliberate, working substitute for live CSequence stepping
— rows 9-11 show the core math is at parity. Do NOT propose porting CSequence wholesale. The
divergences cluster into (a) hook-stream fidelity (#3, #4, #8), (b) root-motion-to-object (#2),
and (c) the clock contract (#1, #5, #6 — mostly owned by DESIGN.md Stage 2). Plan targets (a)
and (b); (c) is a delta note to A3/A4.

### Stage P1 — hook-stream fidelity: drain-to-completion + deferred fire (JS-live)
- Scope: fix #3 and #4 inside the existing executor without changing the bake.
  1. In `_tickAnimationHooks`, replace the `!action.isRunning()` skip with a
     finish-drain: when an action transitions running→finished since the last tick, fire
     `(lastHookTime, clipDuration]` once, then mark the timeline drained (mirrors retail's
     clamp-to-high_frame + crossed-frame fire, acclient.c:340697-340727).
  2. Collect fired hooks into a per-entity queue and execute it once per entity tick AFTER
     pose/position application (retail `process_hooks` placement, acclient.c:320035); route the
     mixer `finished`-event work through the same queue so completion ordering matches retail's
     interleaved `anim_done_hook` (acclient.c:340764-340774).
- Files: `apps/holtburger-web/scene3d/entities.js` only (`_tickAnimationHooks`,
  `_fireHooksInRange`, the `finished` listeners at 7506-7516).
- New module shape: none — a `_hookFireQueue` array on `EntityInstance` + one drain call in
  `tick(dt)`.
- Flag: `?hookDrain=1` (default-off), registered in `docs/url-flags.md` style.
- JS-live. Tests: headless-now — node harness feeding synthetic action time series
  (t crosses duration between ticks) asserting trailing hooks fire exactly once and after
  pose application; 1070-gated — door/lever close-thunk and swing-end sound spot-check.
- Rollback: flag off restores the inline path.

### Stage P2 — one clock domain for hook side-effects (JS-live)
- Scope: fix #8 — convert `_tickSwingTween` / `_tickJumpPoseTween` / `_tickCastTween` /
  `_tickScaleHookTween` from `performance.now()` to the same accumulated dt the mixer consumes
  (entities.js:9024-9078 → dt accumulation like `_tickHookOmega` at 9095). Retail precedent: one
  quantum drives everything (acclient.c:340659-340780).
- Files: `apps/holtburger-web/scene3d/entities.js`.
- Flag: `?tweenClock=dt` (default-off). JS-live.
- Tests: headless-now — simulate a 2s dt gap (tab throttle) and assert tween phase equals mixer
  phase. Rollback: flag off.

### Stage P3 — root-motion-to-object contract (wasm-rebuild, design-first)
- Scope: fix #2 — translating one-shots should move the OBJECT, not just the rig. Emit the
  baked clip's net root displacement (already accumulated in `pos_accum`/`ori_accum`,
  lib.rs:5715-5720) as a per-clip metadata field; on one-shot completion, apply it to the entity
  anchor through the position-correction owner (A2's `position_manager` shape) gated on
  contact, mirroring `transient_state & 2` zeroing + `m_scale` scaling
  (acclient.c:320014-320026). Per-frame object motion (true retail) is deferred — completion-
  time application removes the visible snap at a fraction of the risk.
- Files: `apps/holtburger-web/src/lib.rs` (metadata export), `scene3d/entities.js`
  (apply-on-finished), seam with A2/A6 for who owns the anchor write.
- Flag: `?rootMotionObject=1` (default-off). Wasm-rebuild (batch with other Rust stages).
- Tests: headless-now — bake a known translating anim (door 0x03xx) and assert net displacement
  metadata matches the cumulative pos sum; 1070-gated — lunge/knockback eye-test, door anchor.
- Rollback: flag off; depends-on: A2 position-owner plan, Stage 1 eye-test PASS.

### Delta notes (no stages here)
- To A3/A4: divergence #5 — retail's runtime re-rate/reverse (`multiply_cyclic_animation_fr`
  negative multiplier, acclient.c:340968-340979) has no representation; any future
  `re_modify`/StopSequenceMotion port (A4) must either trigger a re-bake or accept the gap.
  Also `cycleTimeScale`'s 0.25 floor (animation.js:280) forbids retail's rate-0.0 freeze
  (acclient.c:337276).
- To A16: divergence #1/#6 clock contract is already specced as movement DESIGN.md Stage 2
  (`motion_sequence.rs`) for the local player; REMOTE entities remain un-contracted — flag as a
  roadmap follow-on, not part of this plan.

## 5. Scores
- Leverage: P1 subsumes no open IDs directly but de-risks every hook-driven feature
  (G14/T4b-style routing lands on a correct executor); P3 connects to G10/G12 and DESIGN.md
  Stage 2; backlog IDs referenced: G10, G12, G14, DIM5-2 (shipped), Issue-B/DIM3-4 (shipped),
  Cohere-B/T3/T4 (shipped).
- Regression-risk reduction: M (hook executor is a single choke point used by ~26 hook types).
- Implementation risk: P1 L, P2 L, P3 M (touches anchor ownership — seam-dependent).
- 1070-dependency: P1/P2 partially (headless harness covers logic; eye-tests gated), P3 Y.
- Depends-on: P3 → A2 (position owner) + Stage 1 eye-test PASS; #5/#6 → A3/A4 (DESIGN.md Stage 2).

## 6. SPECULATIVE / UNRESOLVED
- **Per-part anim swaps under playback** (`CPartArray` anim-part replace while a sequence runs)
  — retail side located only as struct surface (`acclient.h` CPartArray); did not find a body
  proving mid-cycle part-swap re-binding semantics. Our ReplaceObject hook 5 path exists
  (entities.js:10078; bug tracked as G11). Single-cited → unresolved whether retail re-snaps the
  swapped part to the current frame_number within the same update.
- **three.js `finished` dispatch timing** — claim in row 4 that `finished` fires during
  `mixer.update` rests on three.js library behavior, not a repo cite. Greps tried:
  `addEventListener("finished"` (entities.js:7516 only registers). If three.js defers to end of
  update the ordering inversion still holds (mixer.update at 8995 precedes hooks at 9009) but the
  intra-update detail is unverified.
- **`transient_state & 2` bit identity** — read as CONTACT from the zeroing behavior at
  acclient.c:320014-320026; did not chase the enum definition in acclient.h. The P3 gate should
  pin this before implementation (grep `transient_state` enum / `CONTACT_TS` in acclient.h).
- **Hook-type coverage parity table** — ours dispatches types 1-26 (entities.js:9566-10100); a
  type-by-type diff against retail's `CAnimHook::UnPackHook` factory (acclient.c:7070 decl) was
  not performed (bounded effort); the 2026-05-29 census (6419 hooks) suggests coverage but the
  retail-side per-type Execute bodies were not individually cited.
