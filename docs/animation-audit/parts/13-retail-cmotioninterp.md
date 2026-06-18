I now have the complete retail architecture and concrete holtburger evidence. Here is my structured findings report.

---

## What exists

Retail Asheron's Call routes **every** animated physics object — players, monsters, doors, projectiles, NPCs — through **one** motion authority, a four-layer interpreter stack that turns a single `motion` command (a 32-bit ID) into a chained, frame-accurate animation sequence with baked-in root motion and per-frame hooks. The layers, with their owning structs (`acclient.h`):

| Layer | Struct (acclient.h) | Role |
|---|---|---|
| Per-object façade | `MovementManager` (30943) | Owns the interpreter; lazy-creates it; single entry point `PerformMovement` |
| **Motion interpreter** | **`CMotionInterp` (31407)** | The state machine: raw vs interpreted motion state, hold-key, jump, queue |
| Table driver | `MotionTableManager` (31097) | Bridges interpreter → data table; owns `MotionState` + pending-animation queue |
| Data table (read-only DAT) | `CMotionTable` (31654) | `cycles` / `modifiers` / `links` / `style_defaults` hash tables — the *graph* of legal transitions |
| Playing sequence | `CSequence` (30747) | The concrete chained anim list + velocity/omega; advanced per frame |

Crucially, `CPartArray` (30762) — the renderable part array that every `CPhysicsObj` owns — embeds **`CSequence sequence`** and **`MotionTableManager *motion_table_manager`** as members (30766–30767). Motion is not a side-system; it is part of the object's geometry container. There is exactly **one** `CSequence` per object and exactly **one** update call per object per frame.

By contrast, holtburger (`scene3d/entities.js`, 12,555 lines) has **no** interpreter. Each entity gets a raw `THREE.AnimationMixer` (entities.js:3280) and motion is reconstructed ad hoc from a stance-keyed cycle map plus `crossFadeTo`/`fadeOutCurrent` weight-blends (entities.js:2139, 2223), with the retail link/modifier table consulted only as an out-of-band WASM lookup (`classifyMotionCommandTyped`, entities.js:1914).

---

## How it works (file:line)

### CMotionInterp state (acclient.h:31407–31420)
```c
struct CMotionInterp {
  int initted;                              // default-state entered?
  CWeenieObject *weenie_obj;                // gameplay owner (autonomy/exhaustion checks)
  CPhysicsObj  *physics_obj;                // the object it drives motion for
  RawMotionState         raw_state;         // what the LOCAL controller wants (31372)
  InterpretedMotionState interpreted_state; // what is ACTUALLY being executed (31389)
  float current_speed_factor;
  int   standing_longjump;
  float jump_extent;
  unsigned int server_action_stamp;         // ordering vs server-authoritative actions
  float my_run_rate;
  LList<CMotionInterp::MotionNode> pending_motions;
};
```
Two parallel state records are the heart of the design: **`raw_state`** (intent: `forward_command`, `sidestep_command`, `turn_command`, each with a `HoldKey` + speed; 31372–31386) and **`interpreted_state`** (the resolved, possibly-clamped version actually fed to animation; 31389–31399). `apply_current_movement` reconciles them.

### Ownership & lifecycle
- `CMotionInterp::Create(physics_obj, weenie_obj)` (acclient.c:344526) allocates the interpreter and binds both objects via `SetPhysicsObject`/`SetWeenieObject` (344354, 344335).
- `MovementManager` lazy-creates and owns it: on first `PerformMovement` it calls `CMotionInterp::Create` then `enter_default_state` (acclient.c:~339194–339200), then delegates to `CMotionInterp::PerformMovement`. The same lazy-create pattern repeats for every entry point (339230, 339283, 339339).
- `enter_default_state` (344560) resets both states, calls `CPhysicsObj::InitializeMotionTables`, seeds `pending_motions`, sets `initted=1`, and calls `LeaveGround`.

### The command path — one funnel, `PerformMovement` (acclient.c:344670)
`CMotionInterp::PerformMovement` is a single switch on `MovementStruct::type` (acclient.h:38069) — **the same five opcodes serve players, monsters, doors, and missiles**:
```
case 1: DoMotion              // discrete motion w/ raw-state apply
case 2: DoInterpretedMotion   // server-driven motion
case 3: StopMotion
case 4: StopInterpretedMotion
case 5: StopCompletely
```
…and **every** case is followed by `CPhysicsObj::CheckForCompletedMotions` (344684–344704). One code path, uniform completion handling.

`DoMotion` (344600) → `adjust_motion` (speed/holdkey clamp) → `DoInterpretedMotion` (343975) → `CPhysicsObj::DoInterpretedMotion` (315753) → `CPartArray::DoInterpretedMotion` (326018). That last function builds a `MovementStruct{type=2, motion, params}` and calls **`MotionTableManager::PerformMovement(mvs, &this->sequence)`** (326043) — note it passes the object's own embedded `CSequence`.

### The table driver (acclient.c:330206)
`MotionTableManager::PerformMovement` dispatches into the data table and **queues** the resulting animation count:
```c
case type==2: CMotionTable::DoObjectMotion(table, motion, &state, seq, params->speed, &num_anims)
              → add_to_queue(motion, num_anims, seq)      // 330225–330227
case type==4: CMotionTable::StopObjectMotion(...)         → add_to_queue(0x41000003, ...)
case type==5: CMotionTable::StopObjectCompletely(...)     → add_to_queue(...)
```

### The transition graph — `GetObjectSequence` (acclient.c:337641)
This is the piece holtburger lacks entirely. `DoObjectMotion` (339023) is a one-line forward to `GetObjectSequence`, which, given `(curr_state, motion, speed)`, builds a **chain** of animations into the `CSequence`:
1. Resolves the current style's default substate (`style_defaults` lookup, 337691).
2. Computes the **pre-link** transition anim from current substate (`get_link`, 337708/337585) — the "get from where I am to where I'm going" animation.
3. Looks up the target in `cycles` (looping) or `modifiers` (overlay) or treats it as an action (337720, 337765, 337845).
4. Tears down the old cyclic anims and rebuilds: `CSequence::clear_physics` + `remove_cyclic_anims` then `add_motion(pre_link)` → `add_motion(link)` → `add_motion(target)` (337736–337741).
5. Re-applies persistent **modifiers** (combat stance, damage states) via `re_modify` (337745) and updates `MotionState{style, substate, substate_mod}` (337742–337744).
6. Returns `num_anims` — how many discrete anims were queued, used by the completion queue.

`MotionState` (acclient.h:31081) holds `style` (combat stance), `substate` (current loop), `substate_mod` (speed), plus `modifier_head` / `action_head` lists — so overlays (e.g. "wounded" + "running" + "casting") **compose by construction**, not by weight blending.

### The per-frame authority — ONE update (acclient.c:319989)
`CPhysicsObj::UpdatePositionInternal(quantum, o_newFrame)` is the single per-frame motion tick:
```
offset_frame = identity
CPartArray::Update(part_array, quantum, &offset_frame)   // 320013 — animation fills offset_frame
offset_frame.origin *= m_scale                            // 320017 — scale root motion
PositionManager::adjust_offset(offset_frame, quantum)     // 320030 — interpolation correction
Frame::combine(o_newFrame, m_position.frame, &offset_frame)  // 320031 — APPLY anim delta to world pos
CPhysicsObj::UpdatePhysicsInternal(quantum, o_newFrame)   // 320034 — gravity/collision on result
CPhysicsObj::process_hooks()                              // 320035 — fire queued anim hooks
```
`CPartArray::Update` (325140) is a one-liner: `CSequence::update(&this->sequence, quantum, offset_frame)` (325142). `CSequence::update` (340951) → `update_internal` (340659), which is where **root motion and hooks are produced**:
- Per frame *crossed* this quantum, it accumulates the animation's `pos_frames` displacement into `retval` via `Frame::combine` (340713–340720) — **this is retail's "per-crossed-frame partial application"**.
- It calls `apply_physics` to fold the anim's velocity/omega into the sequence (340723).
- It fires `execute_hooks(animframe, dir)` (340726) for **every crossed frame** — `execute_hooks` (339683) walks `animframe->hooks` and queues each via `add_anim_hook`. This is how footstep sounds, attack-impact triggers, particle emits, and "attached object" events fire at exact frames in both directions (dir = +1/−1).
- On reaching an anim's end it queues `anim_done_hook` (340773) and calls `advance_to_next_animation` (340775) to chain to the next link in the sequence — automatic, no external orchestration.

### Completion (acclient.c:329960)
`MotionTableManager::CheckForCompletedMotions` drains `pending_animations`; for each finished node it pops the action (`MotionState::remove_action_head`, 329976) and calls `CPhysicsObj::MotionDone(motion, success)` (329977). Completion is **data-driven by the queued `num_anims`**, not by JS timers.

---

## Fragility & workarounds

Holtburger's `entities.js` rebuilds fragments of the above on top of `AnimationMixer`, and its own comments repeatedly flag the gaps:

- **No single authority / N parallel mixers.** "one Object3D rig + one AnimationMixer" per entity (entities.js:1984, 3280); the per-frame driver is "walk every mixer, call `mixer.update(dt)`" (entities.js:418). Motion is split across `crossFadeTo` (2139), `fadeOutCurrent` (2223), `_swingHold` timers (5957–6173), `_suppressBaseCycleForOverlay` (8338), and `_armRootMotionOnFinish` (8392) — there is no `PerformMovement` funnel and no `MotionState`.
- **Weight-blend instead of sequence chaining → upper-body-only attacks.** Three.js normalizes a one-shot overlay against the still-running locomotion cycle to ~50/50, "so swings play at half amplitude and pop to the base pose in one frame at clip end" (entities.js:8334). The fix is a manual `setEffectiveWeight(0)` ramp with a `finished` listener to restore it (`_suppressBaseCycleForOverlay`, 8338) — explicitly described as "Mirrors retail's `remove_cyclic_anims`-then-re-add." This is hand-rolling `GetObjectSequence`'s `remove_cyclic_anims` + `add_motion` (acclient.c:337737–337741) per swing.
- **Root motion bolted on as a completion listener.** `_armRootMotionOnFinish` (8392) applies a clip's net displacement only if it "runs to natural completion"; an interrupted overlay "applies NOTHING (accepted approximation gap vs retail's per-crossed-frame partial application, acclient.c:340713-340727)" (entities.js:8388–8391). Retail applies displacement every crossed frame in `update_internal`, so interruption is automatically correct; holtburger's loses it.
- **Timer-driven peaks, not frame hooks.** Swing impact uses `_swingHold.startedMs` + `setTimeout` peak timers ("timer-driven, not [frame-driven]", entities.js:557) and a triangle-wave amplitude tween (5645, 6356). Retail fires impact via per-frame `execute_hooks` (acclient.c:340726/339683), so it is frame-exact and survives speed/interrupt; the JS timers drift and break independently.
- **Missiles fire with no animation.** The launch path is gated on a non-missile velocity check (entities.js:3382–3396) and the missile branch carries only ballistic data (`maximumVelocity`, 4726/4786); there is no motion command routed for the projectile because there is no interpreter that would treat a missile like any other `CPhysicsObj` with a `CSequence`.
- **The link table exists but is read out-of-band.** `classifyMotionCommandTyped` (entities.js:1914) calls a WASM `MotionTable.links[(stance, Ready)][cmd]` lookup just to *classify* a command as swing/cast (1922–1930). The data is present; what's missing is an interpreter that *consumes* `links`/`cycles`/`modifiers` to build a chained sequence — so each motion category (death, door, attack) is handled by a separate special case and "break[s] independently."

---

## Retail (acclient) comparison

| Concern | Retail (acclient) | Holtburger (entities.js) |
|---|---|---|
| Authority | One `CMotionInterp` per object, owned by `MovementManager` (h:30943, c:344670) | N ad-hoc handlers over a raw `AnimationMixer` (3280) |
| Command surface | 5 opcodes via `PerformMovement` for ALL objects (c:344670) | Per-category methods: swing, cast, missile, door, death — separate paths |
| Transition logic | `CMotionTable::GetObjectSequence` builds pre-link→link→target chain (c:337641) | `crossFadeTo`/`fadeOutCurrent` time-based weight blend (2139, 2223) |
| Layering | `MotionState` style+substate+**modifier/action lists** compose (h:31081) | three.js auto-normalized action weights; manual weight-0 hack (8338) |
| Root motion | Accumulated **every crossed frame** via `Frame::combine(pos_frames)` (c:340713) | Net displacement on `finished` only; lost on interrupt (8388) |
| Frame events | `execute_hooks` per crossed frame, bidirectional (c:340726/339683) | `setTimeout` peak timers, drift-prone (557, 6151) |
| Completion | `num_anims` queue → `CheckForCompletedMotions`→`MotionDone` (c:329960) | per-handler `finished` listeners, each its own bookkeeping |
| Per-frame cost | One `CSequence::update` per object (c:325142) | One `mixer.update` per object + tweens + timers + listeners |
| Missiles | Just another `CPhysicsObj` with a `CSequence` — uniform | Special ballistic branch, no motion command (3382, 4726) |

The decisive difference: retail **constructs the correct full-body, multi-anim sequence up front** (data-driven from the motion table) and then just advances it; holtburger **blends independent clips at runtime** and patches each emergent artifact (half-amplitude, lost root motion, pop-to-base, missing impact) with a separate workaround.

---

## Consolidation recommendations

Introduce **one motion authority** in the web client that mirrors the `CMotionInterp` → `MotionTableManager` → `CMotionTable` → `CSequence` stack, with `AnimationMixer` demoted to a dumb clip sampler. The interface to mirror:

1. **`MotionInterp` per entity, owned by the entity (mirror `CMotionInterp`, h:31407 / `CPartArray`, h:30762).** Hold `{ rawState, interpretedState, motionState, physicsObj }`. It — not call sites — owns the rig. Replace the scattered swing/cast/missile/door/death handlers with this one object.

2. **A single command funnel `performMovement(mvs)` (mirror c:344670).** One method, the 5 opcodes (`DoMotion`, `DoInterpretedMotion`, `StopMotion`, `StopInterpretedMotion`, `StopCompletely`), each ending in `checkForCompletedMotions`. Every animated thing — player, monster, **missile**, door — enters here. Missiles stop being a special case: they get a `CSequence` and a launch motion like anything else.

3. **A real `MotionState` (mirror h:31081): `{style, substate, substateMod, modifiers[], actions[]}`.** This is what makes attacks full-body and overlays composable. Building the sequence from this state replaces `_suppressBaseCycleForOverlay`'s manual weight-0 ramp (entities.js:8338) outright.

4. **A `getObjectSequence(state, motion, speed)` that consumes the existing WASM `cycles`/`modifiers`/`links` tables (mirror c:337641).** You already read `links` in `classifyMotionCommandTyped` (entities.js:1914) — promote that from a classifier to the sequence *builder*: emit `[preLink, link, target]` + re-applied modifiers as an ordered clip list. This replaces `crossFadeTo`/`fadeOutCurrent` (2139/2223) with deterministic chaining.

5. **A `Sequence` object advanced once per frame (mirror `CSequence::update`, c:340659).** `update(dt)` should: sample clips into a single pose, accumulate **root motion every frame** into an offset transform (mirror `Frame::combine` at c:340713 — fixes the interrupt gap admitted at entities.js:8388), fire **frame hooks bidirectionally** (mirror `execute_hooks`, c:339683 — replaces `setTimeout` peak timers at 557/6151 with frame-exact impact/footstep/particle events), and auto-advance to the next link on clip end (mirror `advance_to_next_animation`, c:340775). `AnimationMixer.clipAction(...).play()` becomes the leaf sampler only.

6. **One update order per entity (mirror `UpdatePositionInternal`, c:319989):** `sequence.update(dt) → offset` → apply offset to entity transform (`Frame::combine`, c:320031) → physics/interp correction → drain hooks (`process_hooks`, c:320035). Replace the per-mixer `mixer.update(dt)` loop (entities.js:418) with this single, ordered tick.

7. **Completion via a queued anim count (mirror `add_to_queue` + `CheckForCompletedMotions`, c:330227/329960),** not per-handler `finished` listeners. One queue, one `motionDone(motion, success)` callback — death, door, and attack completions stop diverging.

Net effect: the four named defects collapse into one root cause and one fix. Half-body attacks, no-animation missiles, and independently-breaking death/door animations are all symptoms of *no sequence authority*; a `MotionInterp`/`Sequence` pair that the renderer feeds (rather than orchestrates around) removes the per-symptom workarounds (`_swingHold`, `_suppressBaseCycleForOverlay`, `_armRootMotionOnFinish`, the missile velocity gate) instead of adding more.
