I have everything needed. Both sides are fully traced. Here is the structured audit.

---

## What exists

**Retail (`acclient.c`) — ONE motion authority, a discrete-keyframe bone-poser.**

Every animated object in retail (player, monster, door, missile, particle emitter — anything with a `CPartArray`) is posed by the *same* code path. There is exactly one place that writes a part's final transform, one place that advances animation time, and one place that fires animation callbacks. The data model is dead simple: an animation is an array of keyframes; each keyframe holds one position+quaternion **per part** plus an optional hook list. Posing = "snap each part to keyframe N." No blending, no weights, no crossfade engine.

The relevant types (`acclient.h`):

- `CAnimation` (`acclient.h:31619`) — a DAT animation asset:
  - `AFrame *pos_frames` — per-frame **root motion** (object-space displacement)
  - `AnimFrame *part_frames` — per-frame **part poses**
  - `unsigned int num_frames`, `num_parts`
- `AnimFrame` (`acclient.h:31072`) — one keyframe:
  - `AFrame *frame` — array of `num_parts` local transforms (the per-part pose)
  - `CAnimHook *hooks` + `num_frame_hooks` — events attached to *this* frame
- `AFrame` (`acclient.h:31629`) — `{ Vector3 m_fOrigin; float qw, qx, qy, qz; }` — **position + quaternion, nothing else.** This is precisely a three.js `Object3D` `.position` + `.quaternion`.
- `anim_done_hook` (`acclient.c:45218`) — a single global `CAnimHook { AnimDoneHook::vftable, NULL, -2 }` reused as the end-of-animation sentinel.

**Holtburger (`scene3d/`) — NO motion authority.** Raw AC keyframes are converted to `THREE.AnimationClip`s (`scene3d/animation.js:1-11`) and handed to a per-entity `THREE.AnimationMixer` (`entities.js:3280`). Motion logic — which clip plays, at what weight, crossfading with what, one-shot vs. loop, when it "ends" — is scattered across `entities.js` (`crossFadeTo` :2139, `swingMotion` :6076+, sidestep overlay :7106+, `setMotion` :6505+, `_tryPlayLink`) and a diagnostics shim `diag/motion.js`. The mixer *sums weighted poses across all playing actions* — a fundamentally different model than retail's "snap to keyframe."

---

## How it works (file:line)

### The retail pose pipeline, per physics tick

Driven from `CPhysicsObj::UpdatePositionInternal` (`acclient.c:319989`), the order each tick is:

**1. Advance the sequence & accumulate root motion** — `CPartArray::Update` (`acclient.c:325140`) → `CSequence::update` (`:340951`) → `CSequence::update_internal` (`:340659`):
- `frame_number += framerate * quantum` (`:340690`, `:340695-340696`) — time advances in *frames*, scaled by the per-motion `framerate` (this is where speed/haste multiplies — see `multiply_framerate` `:340968`).
- For **each integer frame crossed** (`:340713`):
  - root motion: `Frame::combine(retval, retval, get_pos_frame(v6))` (`:340719-340720`) — accumulates the object-space displacement into the offset frame.
  - **fire that frame's hooks**: `execute_hooks(get_part_frame(v6), +1)` (`:340725-340726`). Reverse playback uses `-1` (`:340758-340759`).
- When the play head passes the animation's last frame (`advance_anim = 1`, `:340709-340710`), and this isn't a cyclic anim, it **queues the AnimationDone sentinel**: `CPhysicsObj::add_anim_hook(hook_obj, &anim_done_hook)` (`:340772-340773`), then `advance_to_next_animation` (`:340775`).

**2. Compute the object's world frame** — `Frame::combine(o_newFrame, m_position.frame, offset_frame)` (`:320031`).

**3. Apply the final per-part pose** — `CPhysicsObj::UpdatePhysicsInternal` (`:320034`) → `CPartArray::SetFrame` (`:326766`) → **`CPartArray::UpdateParts` (`acclient.c:326601`)** — this is THE bone-poser, the entire thing:

```c
v3 = CSequence::get_curr_animframe(&this->sequence);          // :326611
v4 = min(num_parts, animframe->num_parts);                    // :326615-326617
for (each part i < v4)
    Frame::combine(&parts[i]->pos.frame,  frame,  &animframe->frame[i],  &scale);  // :326624
```

For every part, the final render transform is `world_frame ∘ keyframe_local[i]`, scaled. That's it. The current keyframe is selected by `CSequence::get_curr_animframe` (`:339745`): `part_frames[floor(frame_number)]` (`:339757`), or the static `placement_frame` (rest pose) when no animation is active (`:339761`). **Discrete frame index — no interpolation between keyframes, no blend across animations.**

**4. Fire queued hooks** — `CPhysicsObj::process_hooks` (`:318641`, called at `:320035`) drains two queues:
- `this->hooks` — persistent typed hooks (translucency, scale, callbacks); `Execute` returns "done?" and self-deletes (`:318658-318672`).
- `this->anim_hooks` — the per-frame `CAnimHook`s queued this tick; each `Execute(this)` is called, then the array is cleared one-shot (`:318683-318688`).

### How AnimationDone fires (the exact chain)

The end-of-anim sentinel rides the *same* hook queue as every other per-frame event. When `process_hooks` reaches it:

`AnimDoneHook::Execute` (`acclient.c:342336`) → `CPhysicsObj::Hook_AnimDone` (`:317087`) → `CPartArray::AnimationDone` (`:325080`) → `MotionTableManager::AnimationDone` (`:329873`).

`MotionTableManager::AnimationDone` (`:329873`) is the gameplay bridge: it bumps `animation_counter` (`:329887`), and for each queued motion whose threshold the counter has reached (`:329890`), pops it and calls `CPhysicsObj::MotionDone(physics_obj, motion_id, success)` (`:329894`) — which notifies the `MovementManager` (`:317097`) so the *next* queued motion can start. This is the back-pressure that makes chained motions (windup→strike→recover, open→opened) sequence correctly. `0x10000000` flagged motions also pop the action head (`:329892-329893`).

So animation **events** and animation **completion** are the same mechanism: hooks attached to keyframes, drained once per tick, in frame order.

### The holtburger pipeline

- Keyframes → clip: `animation.js:36-205` builds a `VectorKeyframeTrack` (`part_N.position`) + `QuaternionKeyframeTrack` (`part_N.quaternion`) per part, reordering AC `(qw,qx,qy,qz)` → three `(x,y,z,w)` (`:13-17`). The raw data layout (`partFrames`: `[(x,y,z,qw,qx,qy,qz) per part] per frame`, `animation.js:4-5`) is byte-for-byte the retail `AnimFrame::frame[]` of `AFrame`s.
- Clip → motion: `THREE.AnimationMixer` per entity (`entities.js:3280`); `mixer.update(dt)` per rAF (`loop.js:7`).
- "AnimationDone": there is no hook stream. JS reconstructs it out-of-band — `planHookWindows` (`scene3d/hook_windows.js:37`) detects LoopOnce completion by watching `lastTime < clipDuration`, and `SessionHandle.notifyAnimationDone(guid, success)` (`src/lib.rs:27797`) round-trips a `SessionCommand::AnimationDone` (`src/lib.rs:41083`) back into wasm. The Rust core's own doc-comments (`src/lib.rs:17915-17919`, `:27782-27784`) cite `acclient.c:342336`/`:317093` — it *knows* the retail model and is approximating it through three.js's timeline instead of owning it.

---

## Fragility & workarounds

Every observed bug traces to the mixer's **weighted-pose-summation** model standing in for retail's **single authoritative keyframe write**.

- **"Attacks only swing the upper body" / half-amplitude swings.** A swing is played as a LoopOnce *overlay* on top of the locomotion cycle (`entities.js:6076-6108`). The mixer sums overlay+base at normalized weights, so the swing comes out at ~50% amplitude. The fix is a feature-flagged hack, `FULL_BODY_ONE_SHOT` / `?fullBodyOneShot=on` (`entities.js:6116-6142`), whose own comment admits: *"three.js still normalizes overlay+base to ~50/50 → the swing plays at half amplitude"* (`:6126-6129`). It then has to manually ramp the base cycle to zero via `_suppressBaseCycleForOverlay` (`:6141`) for the overlay's duration. In retail this is impossible by construction: `UpdateParts` (`acclient.c:326624`) writes the swing keyframe to **all** parts unconditionally; there is no second pose to average against.

- **Sidestep "diagonal walk."** The strafe cycle is blended at `setEffectiveWeight(0.5)` against the forward cycle (`entities.js:7109-7114`), explicitly: *"Three.js mixers sum weighted poses across all enabled actions; equal weights yield a midpoint pose."* That midpoint is an artifact of the blend engine; retail just plays the correct sidestep animation as the current sequence.

- **Crossfade soup.** `crossFadeTo` (`entities.js:2139-2245`) juggles `fadeIn`/`fadeOut`/`crossFadeFrom`/`setEffectiveWeight` with branchy special-cases (`:2179`, `:2196`, `:2211`, `:2245`). Each motion type re-derives transition behavior. Retail has no transitions at all — `set_placement_frame` / `append_animation` swap the sequence and the next tick poses the new frame (`CSequence::append_animation` `:340590`, `clear_animations` `:340102`).

- **Missiles fire with no animation.** One-shot motions route through `_tryPlayLink` as LoopOnce overlays (`entities.js:1034`, `:1188-1229`), and when the link clip resolves null the overlay *"quietly"* no-ops (`:1793-1795`, `:7100-7103`). A missing clip = a silently dropped animation. Retail can't drop it: the motion is appended to the sequence and either has frames (it poses) or falls back to `placement_frame` — there's no overlay to "miss."

- **Independent death/door breakage.** Because each motion class (swing, cast, sidestep, jump, emote, link) has its own play/blend/restore code and its own ad-hoc completion detection (`hook_windows.js`, peak-hold `setTimeout` at `entities.js:6157-6188`, `_swingRestoreTimer`, `notifyAnimationDone` round-trip), fixing one class doesn't fix the others — they share no authority. A door's "opened" hold and a monster's death pose are reconstructed independently. Retail's `MotionDone` chain (`acclient.c:329894`) sequences *all* of them through one queue.

- **Out-of-band completion is lossy.** `planHookWindows` infers completion from clip time (`hook_windows.js:62`) and bounces through wasm (`src/lib.rs:27797`, `:41083`). Any reused/clamped/paused action (e.g. the peak-hold pause, `entities.js:6166`) can desync this inference from the true frame, so AnimationDone fires early/late/never. Retail emits it deterministically as a hook at the real last frame (`acclient.c:340772`).

---

## Retail (acclient) comparison

| Concern | Retail (`acclient.c`) | Holtburger (`scene3d/`) |
|---|---|---|
| Pose authority | **One** function: `CPartArray::UpdateParts` (`:326601`) writes `parts[i].pos.frame = world ∘ keyframe[i]` (`:326624`) | Scattered across `entities.js`; final pose is the mixer's weighted **sum** of all playing actions |
| Frame selection | `get_curr_animframe` = `part_frames[floor(frame_number)]` (`:339757`) — discrete keyframe | Mixer interpolates tracks continuously per `mixer.update(dt)` |
| Blending | **None.** Current sequence fully owns every part each tick | `crossFadeTo`/`setEffectiveWeight`/additive overlays (`entities.js:2139`, `:6106`, `:7114`) |
| Per-part data | `AFrame{ origin, qw,qx,qy,qz }` (`acclient.h:31629`) | `VectorKeyframeTrack` + `QuaternionKeyframeTrack` (`animation.js:197-205`) — **identical data** |
| Events / hooks | Per-keyframe `AnimFrame.hooks` (`acclient.h:31076`), fired in frame order by `execute_hooks` (`:339683`) during sequence advance | `hookTimelines` + `planHookWindows` time-window inference (`hook_windows.js`) |
| AnimationDone | `anim_done_hook` sentinel (`:45218`) queued at last frame (`:340772`) → `MotionTableManager::AnimationDone` (`:329873`) → `MotionDone` chains next motion | `notifyAnimationDone` round-trip from JS time-inference (`src/lib.rs:27797`) |
| Motion sequencing | `MotionTableManager` pending-animation queue + `animation_counter` (`:329887-329894`) | Per-class timers/flags (`_swingRestoreTimer`, peak-hold `setTimeout`, `FULL_BODY_ONE_SHOT`) |

The decisive structural fact: in retail the three.js-equivalent step is the **last and dumbest** step. `UpdateParts` does one `Frame::combine` per part and stops. All intelligence — which frame, when it ends, what fires, what plays next — lives upstream in `CSequence` + `MotionTableManager`. Holtburger inverts this: the *renderer* (`AnimationMixer`) holds the intelligence (interpolation, weight-summing, transition timing), and the motion logic above it fights the renderer to undo blends it didn't want.

---

## Consolidation recommendations

The goal: **demote three.js to retail's `UpdateParts` role — a per-part `position`/`quaternion` setter — and move all motion intelligence into one authority** that mirrors `CSequence` + `MotionTableManager`. The Rust core already references these exact `acclient.c` lines (`src/lib.rs:17915`, `:27782`), so the model is understood; it just isn't enforced.

1. **Build one `MotionInterp` authority (port `CSequence`).** Hold `{ curr_anim, frame_number, framerate, placement_frame }` per entity. Each tick: `frame_number += framerate * dt`; current keyframe = `part_frames[floor(frame_number)]` (mirror `CSequence::update_internal` `acclient.c:340659` and `get_curr_animframe` `:339745`). This replaces `crossFadeTo`, `swingMotion`'s overlay logic, the sidestep blend, and `_tryPlayLink`'s per-class branches with one advance loop. The natural home is the wasm core (it already owns `SessionCommand::AnimationDone`), with JS as the thin pose applier.

2. **Make the renderer a pure poser (port `UpdateParts`).** Replace `mixer.clipAction(...).play()` with a direct per-part write: `partGroup.children[i].position.set(...)`, `.quaternion.set(...)` from the authority's current keyframe — exactly `Frame::combine(parts[i].pos.frame, world, keyframe[i])` (`acclient.c:326624`). **Stop using `AnimationMixer`/`clipAction` for motion entirely** (the `Object3D` rig with named `part_N` children, `animation.js:8-10`, already matches this layout — keep the rig, drop the mixer). No `setEffectiveWeight`, no `crossFade`, no LoopOnce overlays. This single change kills the half-amplitude swing, the diagonal walk, and the silent missile drop simultaneously, because none of them can exist without weight-summing.

3. **Port the keyframe hook stream (port `execute_hooks`).** Attach hooks to keyframes (`AnimFrame.hooks`, `acclient.h:31076`) and fire them in frame order as the play head crosses integer frames (`acclient.c:340725-340726`). Delete `hook_windows.js`'s time-window inference — events become deterministic, not reconstructed from clip time.

4. **Port AnimationDone as a queued sentinel, not an inference (port the `anim_done_hook` chain).** When the play head passes the last frame, enqueue a done-event (`acclient.c:340772`) that flushes once per tick. Route it through a `MotionTableManager`-style pending-motion queue with an `animation_counter` (`:329873-329894`) so chained motions (windup→strike→recover, open→opened, death→corpse) sequence through *one* path. This retires `notifyAnimationDone` round-tripping (`src/lib.rs:27797`), the peak-hold `setTimeout` (`entities.js:6157`), `_swingRestoreTimer`, and the `FULL_BODY_ONE_SHOT` flag — death/door/missile stop being independent because they share the queue.

5. **Delete the workaround layer.** Once 1–4 land, remove: `crossFadeTo` (`entities.js:2139`), `_suppressBaseCycleForOverlay` + `FULL_BODY_ONE_SHOT` (`:6116-6142`), the sidestep 0.5-weight blend (`:7109-7121`), the swing peak-hold timers (`:6151-6188`), and `diag/motion.js`'s mixer-introspection shim. These exist only to fight the mixer; with the mixer gone they have nothing to do.

**Net:** one ~150-line `MotionInterp` + a per-part pose write replaces several thousand lines of crossfade/overlay/weight/timer logic across `entities.js`, and the three "independently breaking" animation systems collapse into one path that is, by construction, the retail path. The data is already in the right shape (`AFrame` ≡ `position`+`quaternion`); only the *authority* needs to move from the mixer to a sequence interpreter.
