I've now read all 18 reports in full. Below is the synthesized authoritative deliverable.

---

# Holtburger Animation Architecture Audit

*Synthesis of 18 component audits of `external/holtburger/apps/holtburger-web` + the retail `acclient.c` CMotionInterp/CMotionTable analysis. Every `file:line` is carried forward from the cited component report.*

---

## 1. Executive Summary — Verdict

**The root-cause hypothesis is CONFIRMED, with high confidence and unanimous evidence across all 18 reports.**

> The defect class — "attacks only swing the upper body," "missiles fire with no animation," "monster-death and doors break independently and each needs weeks of rework" — is not a set of independent bugs. It is the predictable, structural output of **one architectural mismatch: holtburger has no single motion authority, so a three.js `AnimationMixer` (a crossfade/weight-blend engine that *sums weighted poses across all playing actions*) is being made to stand in for Asheron's Call's sequence model (`CMotionInterp` → `CMotionTable::GetObjectSequence` → one `CSequence` per object, a *single-playhead walk over one ordered keyframe list with no blending*).**

The two models are categorically opposed:

| | Retail AC | Holtburger |
|---|---|---|
| Motion model | **One ordered sequence**, one playhead, `frame_number += framerate·quantum` (`acclient.c:340659`) | **N concurrent weighted actions** summed by the mixer (`entities.js:7110-7111`) |
| One-shot (swing/cast/death) | *Prepended* into the same list ahead of `first_cyclic`; runs once, then list-advance wraps back to the cycle (`acclient.c:337737-337741`, `340563-340566`) | *Overlaid* on the still-running locomotion cycle; mixer normalizes the two to ~50/50 (`entities.js:584-591`, `8330-8337`) |
| Blending | **None** — the active sequence owns every part each tick (`UpdateParts`, `acclient.c:326624`) | Weight-summing is the engine's headline feature |

Every named symptom is a direct corollary of that mismatch:

- **"Upper-body-only attacks"** = the mixer normalizing a full-body swing clip + a running walk cycle to ~50/50 weight, so the swing renders at half amplitude (`entities.js:584-591`, `8330-8337`), *plus* the procedural fallback `setSwingPose` which literally rotates only `parts[13]` RIGHT_UPPER_ARM and no-ops entirely on non-humans (`entities.js:5603-5626`, `5607`). Part 04, 03, 15.
- **"Missiles fire with no animation"** = the missile fire command is an aim-level **cycle** (class `0x40`, lives in `MotionTable.cycles`), but the fire path routes it through `setSwingMotion` → `lookupMotionLinkForSwing`, which only searches `MotionTable.links`. The lookup is *structurally incapable* of hitting, so `canPlayReal` is false 100% of the time → `setSwingPose` (single-arm, non-human no-op). The arrow flies only because the projectile is a separate server-spawned entity that never consults the animation system (`entities.js:6039-6048`; `picking.js:1145-1150`; `loop.js:2205-2211`). Part 09.
- **"Death/doors break independently"** = each motion family is on its own ad-hoc sub-path with its own clock and lifecycle. Death's *held pose* rides the locomotion cycle path while its *collapse* rides the attack overlay path — two unsequenced mixer actions racing (`entities.js:1170`, `6711-6724`, `8145`). A door open is a bespoke instantaneous `rotation = ±π/2` snap in `index.html` that touches neither the mixer nor any MotionTable (`index.html:10669-10784`). There is no shared place to fix a class of motion, so each must be debugged and reworked in isolation. Parts 07, 08, 16.

**Two findings sharpen — and bound — the diagnosis:**

1. **The data is not the problem; the runtime is.** The wasm→JS boundary (`EntityAnimationData`, `src/lib.rs:15510-15567`) ships a *faithful, single-contract superset* of what retail's `CSequence` consumes — per-part absolute model-space keyframes, per-segment `frameTimes`, cumulative `posFrames` root motion, net `rootMotionNet`, rest pose, and the full hook timeline — as a documented zero-transform passthrough (`src/lib.rs:14913-14918`), independently validated at 52/52 swing parity and 906/906 DAT. The flat (non-hierarchical) rig is *retail-correct*, not a shortcut (`animation-deep-dive-2026-06-02.md:1206`). **The full-body swing keyframes are present and correct; the half-body symptom is a blend artifact, not missing data** (Part 12). This means the fix is a JS-runtime consolidation, *not* a re-plumbing of the data pipeline.

2. **The team has already found the seam but stopped at flags instead of replacing the model.** `_suppressBaseCycleForOverlay` ramps the base cycle's weight to 0 and is self-documented as *"Mirrors retail's `remove_cyclic_anims`-then-re-add"* (`entities.js:8330-8337`). `CROSSFADE_S = 0` is set *"because retail had no blend between motions … unconditional pointer swap"* (`entities.js:1326-1337`). `fadeOutCurrent` cites *"the PhatSDK equivalent is `advance_to_next_animation()`"* (`entities.js:2239-2241`). These are hand-rolled, per-symptom reimplementations of `GetObjectSequence` primitives — gated behind default-reversible URL flags rather than adopted as the architecture.

**Verdict: build one motion authority that mirrors `CSequence`/`CMotionInterp`, demote `AnimationMixer` to a dumb per-part bone-poser, and migrate each motion family onto it. The four named defects collapse into one root cause and one fix.**

---

## 2. Architecture As-Is — Map of Every Motion Path

Holtburger produces motion from **at least seven independent subsystems**, three of which run *concurrently on the same rig inside the same `tick(dt)` loop* (`entities.js:9947`) and reconcile each other with execution-order hacks (Part 16). There is no `PerformMovement` funnel and no `MotionState`.

**A. The semi-shared "spine" (three.js AnimationMixer).** The closest thing to a single path, reached via `EntityManager.setMotion` (`entities.js:6522`). It normalizes the wire command (Stop/Invalid→Ready `:6549`, Left→Right `:6567`, stance-0 inheritance `:6590`), runs `classifyMotionCommand(cmd)` (`:1745`, `:6602`) — which collapses the entire AC `MotionCommand` enum into six strings via nine hardcoded `Set`s — then forks **three ways**:
- `"stop"`/`null` → `fadeOutCurrent(CROSSFADE_S)` (`:2223`) — mixer fade-out (frozen rest pose).
- `"walk"`/`"run"`/`"idle"` → build cache key → async-fetch clip → `crossFadeTo(action, key, dur)` (`:6868` → `:2139`) — the **locomotion cycle path** (LoopRepeat). This is the *only* family that truly rides the spine.
- `"attack"`/`"cast"` → `_tryPlayLink(...)` (`:6638` → `:8145`) — a **LoopOnce overlay** `play()`'d *on top of* the still-running cycle (`:8261-8262`), deliberately *not* stamping `currentActionKey`.

`CROSSFADE_S = 0` (`:1337`) neuters the blend engine for cycle-to-cycle swaps (hard cut, `.time`-preserved), but the *overlay* path still relies on weight-blending — which is where the 50/50 artifact re-enters. A second clip entry, `setSwingMotion` (`:6014`), exists for the local-optimistic/CMT path and stamps `currentAction` directly, bypassing `crossFadeTo`.

**B. Hand-rolled per-entity pose tweens** (triangle-wave quaternion SLERPs, applied *after* `mixer.update` so they "win", manually nulled where a real clip must take over — `:6643`, `:6647`):
- `setSwingPose`/`_tickSwingTween` (`:5603`/`:6332`) — rotates one bone (RIGHT_UPPER_ARM).
- `setCastPose`/`_tickCastTween` (`:5650`/`:6359`) — both upper arms.
- jump pose `_applyHumanJumpPose`/`_tickJumpPoseTween` (`:5470`/`:6231`) — *pauses the mixer entirely* and SLERPs per-part.

**C. A second, parallel animation engine — the PhysicsScript "hook" system**, all ticked in the same per-entity loop: `_tickAnimationHooks` (`:10894`), `_tickHookOmega` spin (`:12151`), `_tickMaterialHooks` texture velocity (`:12107`), `_tickScaleHookTween` (`:11650`), plus a per-guid `ScriptManager` (`script_manager.js:208`). Dispatch funnels to one `_fireHook` 26-case typeswitch (`:11035`) — but firing and completion are split across inline / drain-queue / `setTimeout`-walker / `ScriptManager` paths, gated behind three default-off flags (`?scriptQueue`, `?hookDrain`, `?mtQueue`) (Part 06).

**D. Hand-rolled transform integration** in the same loop: ballistic projectile Euler-integrate (`:10116`), sticky-melee glue (`:10153`), dead-reckon position ease (`:10179`), heading slerp ease (`:10220`).

**E. Doors — fully independent, *not animated*.** A `DoorStateChanged` (`kind===15`) handler in `index.html` instantly assigns `rotation = open ? π/2 : 0` to up to three different objects (`index.html:10669/10702/10767/10784`), no tween/clock/MotionTable. A whole hinge-wrapper scaffold (`buildings.js:400-421`, `doorRotationRad`) is *dead code* — written-to-zero once, never read. Outdoor/cell statics never animate (`statics.js` mixer count = 0) (Part 07).

**F. Standalone rAF loops, each its own clock:** VFX bursts (`play_effect_vfx.js:640/674`), spell-shape preview (`spell_shape_preview.js:130/637`), speech bubbles (`speech_bubble.js:203`), particles (`particle_manager.js:66`), combat-bar (`combat-bar.js:1049`), camera predictive lerp/slerp (`camera.js:1123/1130/1460`).

**G. Static-pose preview rigs** (`ac_dye_viewport.js:198`, `ac_paperdoll_viewport.js`) and the **legacy 2D PIXI heading path** (`index.html:3999/5837/6620/11648`, direct `sprite.rotation` writes that fight the 3D heading ease).

**The dispatch layer feeding all this is itself forked** (Part 11): five separate motion drains per 3D frame, each its own wasm side-channel + flag (`loop.js:1776-1797`) — `drainEntityEvents3D`, `drainMotionActions` (`?multiAction`), `drainMotionAxes` (`?castAxes`), `drainRemotePoses` (`?remoteInterp`), `applyLocalPlayerPoseFromIntegrator` — plus a local-vs-remote fork *inside* the arms (`_armMotion :2150`, `_armPosition :2087`, `_armTurn :2234` all branch on `isLocalPlayerGuid`), and a host-default mismatch where `unifiedDispatch` is default-ON in `loop.js:291` but default-OFF in `index.html:4657`.

**The clip adapter (`animation.js`) commits the one fatal simplification** (Part 01): it is a *clip factory*, not a sequence builder. The wasm side concatenates the multi-`AnimData` chain (windup→strike→recover→settle) into one monolithic `THREE.AnimationClip` and *discards the sequence structure*. At runtime there is no `curr_anim`, no `frame_number`, no links table — just a flat clip fed to a crossfade engine. Any per-segment decision (interrupt at strike, branch on a link, chain to next) is impossible after the bake. `animation.js` is nonetheless the correct *home* for the interpreter: it is the sole chokepoint between wasm keyframe data and the renderer (its only production importer is `entities.js:479`) and already caches everything an interpreter needs — `framerate`, `frameTimes`, `duration`, decoded hooks, rest pose, `rootMotionNet`, and the segment frames.

---

## 3. Fragmentation Census Table

From Part 16's direct source census: **34 distinct motion entry points; 7 ride the mixer spine; 27 are bespoke; 16 of those live inside `entities.js` alone; 3 separate engines animate the same rig concurrently.** Audio `.play()` and test/capture harnesses excluded.

| # | Entry point | File:line | Mechanism | Class |
|---|---|---|---|---|
| 1 | `setMotion` central router | `entities.js:6522` | classify→3-way fork | Semi-unified spine |
| 2 | `crossFadeTo` (locomotion swap) | `entities.js:2139` | mixer crossfade (hard-cut) | Unified (mixer) |
| 3 | `fadeOutCurrent` (stop) | `entities.js:2223` | mixer fadeOut | Unified (mixer) |
| 4 | `_tryPlayLink` overlay (attack/cast/gesture/jump/death-collapse) | `entities.js:8145`, `8262` | mixer LoopOnce overlay | Unified (mixer) |
| 5 | `setSwingMotion` (2nd clip entry) | `entities.js:6014`, `6108` | mixer clipAction | Unified (mixer) |
| 6 | spawn initial action | `entities.js:3299`, `3326` | mixer clipAction | Unified (mixer) |
| 7 | `mixer.update(dt)` | `entities.js:10355` | mixer tick | Unified (mixer) |
| 8 | velocity-scaled gait timescale | `entities.js:10252-10288` | mixer `effectiveTimeScale` hack | Bespoke (on mixer) |
| 9 | `setSwingPose` / `_tickSwingTween` | `entities.js:5603` / `6332` | single-bone triangle-wave quat tween | **Bespoke** |
| 10 | `setCastPose` / `_tickCastTween` | `entities.js:5650` / `6359` | both-arms quat tween | **Bespoke** |
| 11 | jump pose tween (mixer-bypassing) | `entities.js:5470`, `6231` | per-part SLERP + mixer pause | **Bespoke** |
| 12 | `releaseSwingHold` peak-hold | `entities.js:5953` | mixer time freeze | **Bespoke** |
| 13 | `setPose` / `applyManagedPose` | `entities.js:2111`, `4016` | direct transform write | **Bespoke** |
| 14 | dead-reckon position ease | `entities.js:10179` | exp lerp | **Bespoke** |
| 15 | heading slerp ease | `entities.js:10220` | exp slerp | **Bespoke** |
| 16 | ballistic projectile integrate | `entities.js:10116` | Euler integrate | **Bespoke** |
| 17 | sticky-melee glue | `entities.js:10153` | exp lerp | **Bespoke** |
| 18 | `_tickAnimationHooks` (PhysicsScript) | `entities.js:10894` | hook engine | **Bespoke (2nd engine)** |
| 19 | `_tickHookOmega` (spin) | `entities.js:12151` | omega integrate | **Bespoke (2nd engine)** |
| 20 | `_tickMaterialHooks` (texture velocity) | `entities.js:12107` | uv scroll | **Bespoke (2nd engine)** |
| 21 | `_tickScaleHookTween` | `entities.js:11650` | scale tween | **Bespoke (2nd engine)** |
| 22 | `ScriptManager.update` (per-guid) | `script_manager.js:208` | time-ordered hooks | **Bespoke (2nd engine)** |
| 23 | PhysicsScriptTable fetch/exec | `ui/ac_physics_script_table.js`, `ac_play_script.js` | script table | **Bespoke (2nd engine)** |
| 24 | Door open/close snap | `index.html:10669/10702/10767/10784` | instant `rotation` set | **Bespoke (no anim)** |
| 25 | Door hinge-wrapper scaffold (dead) | `buildings.js:400/420` | static Group rotation | **Bespoke (dead)** |
| 26 | VFX burst tween loop | `play_effect_vfx.js:640/674` | own rAF | **Bespoke (own rAF)** |
| 27 | Spell-shape preview tween | `spell_shape_preview.js:130/637` | own rAF | **Bespoke (own rAF)** |
| 28 | Speech-bubble fade | `speech_bubble.js:203-224` | own rAF | **Bespoke (own rAF)** |
| 29 | Particle sim | `particle_manager.js:66`; `particle.js:424` | own tick + per-particle lerp | **Bespoke** |
| 30 | Combat-bar tween | `combat-bar.js:1049` | UI tween | **Bespoke** |
| 31 | Camera predictive lerp/slerp | `camera.js:1123/1130/1460` | own lerp/slerp | **Bespoke** |
| 32 | Dye preview rig (static pose) | `ac_dye_viewport.js:198/214` | rest-pose, no mixer | **Bespoke (static)** |
| 33 | Paperdoll viewport rig | `ac_paperdoll_viewport.js` | rest-pose, no mixer | **Bespoke (static)** |
| 34 | Legacy 2D heading writes | `index.html:3999/5837/6620/11648` | direct `sprite.rotation` | **Bespoke (2D path)** |

**Concurrency hazard (Part 16):** tweens are slerped *after* `mixer.update` specifically so they "win" (`entities.js:6226`); the swing/cast branch must *manually null* `_swingTween`/`_castTween` (`:6643`, `:6647`) or the placeholder fights the real clip — this *is* the "attacks only swing the upper body" failure when the null is missed. The mixer, hook-omega, material, and tween subsystems also run on divergent clocks and can "tween 2s of wall time while the mixer advances ~16ms" (`entities.js:545-553`), patched with a separate `_tweenClockMs`.

**Flag layer (Parts 02–05, 10, 17):** ~14 URL flags gate core motion correctness, and at least six are **comment/code-inverted** — documented "Default OFF … needs a 1070 eye-test" but coded as `get(x) !== "off"` which is `true` when absent, i.e. **default ON**: `FULL_BODY_ONE_SHOT` (`:592`), `CAST_SPEED` (`:608`), `CAST_STATE_MACHINE` (`:625`), `castFaceTarget`, `castAxes`, `castFizzle`. The most invasive mixer workaround is shipping unguarded while its comments assert it is dormant.

---

## 4. Retail Target Architecture — the model holtburger should mirror

Retail routes **every** animated `CPhysicsObj` — players, monsters, doors, missiles, animating statics — through **one** four-layer interpreter, with three.js's equivalent step (`UpdateParts`) as the *last and dumbest* operation. Motion is part of the object's geometry container, not a side-system: `CPartArray` (`acclient.h:30762`) embeds `CSequence sequence` and `MotionTableManager *motion_table_manager` as members. There is exactly **one** `CSequence` per object and **one** update call per object per frame (Parts 13, 14, 15).

**The stack** (`acclient.h`):

| Layer | Struct | Role |
|---|---|---|
| Per-object façade | `MovementManager` (`:30943`) | Owns/lazy-creates the interpreter; single entry `PerformMovement` |
| **Motion interpreter** | **`CMotionInterp` (`:31407`)** | State machine: `raw_state` (intent) vs `interpreted_state` (executed), hold-key, jump, `pending_motions` |
| Table driver | `MotionTableManager` (`:31097`) | Bridges interpreter→table; owns `MotionState` + `pending_animations` queue |
| Data table (read-only DAT) | `CMotionTable` (`:31654`) | `cycles`, `modifiers`, `links`, `style_defaults` hashes — the graph of legal transitions |
| Playing sequence | `CSequence` (`:30747`) | The chained anim list + velocity/omega; one playhead `curr_anim` + `frame_number` |

**One command funnel.** `CMotionInterp::PerformMovement` (`acclient.c:344670`) is a single switch on five opcodes — `DoMotion`, `DoInterpretedMotion`, `StopMotion`, `StopInterpretedMotion`, `StopCompletely` — **the same five serve players, monsters, doors, and missiles**, every case followed by `CheckForCompletedMotions` (`:344684`). `MotionTableManager::PerformMovement` (`:330206`) dispatches into the table and **queues** the result via `add_to_queue(motion, num_anims, seq)` (`:330225-330227`).

**One sequencer — `GetObjectSequence` (`acclient.c:337641`), the piece holtburger lacks entirely.** It branches purely on the command's high bits and runs the *same* four-step shape for all of them:
- `0x80000000` = style/stance change (`:337699`)
- `0x40000000` = cycle / locomotion / **aim-level** (`:337763`)
- `0x20000000` = additive modifier (`:337814/337870`)
- `0x10000000` = one-shot action — **attack, cast, death, emote, missile-fire** (`:337842`)

The four steps (clearest at `:337736-337745`):
1. `get_link(style, substate, …, motion, speed)` (`:337585`) — resolve the transition anim bridging current→requested.
2. `CSequence::clear_physics` + `remove_cyclic_anims` (`:337736-337737`) — drop only the trailing looping region; one-shot link anims before `first_cyclic` survive.
3. `add_motion(pre_link)` → `add_motion(link)` → `add_motion(cycle)` (`:337738-337741`) — **append, in order**, transition frames then the new cycle. One-shots are *prepended ahead of `first_cyclic`*; the new cyclic is appended (`append_animation` sets `first_cyclic = tail`, `:340624`).
4. Update `MotionState{style, substate, substate_mod}` (`:337742`) and `re_modify` held modifiers (`:337745`).

**One per-frame advance — `CSequence::update_internal` (`acclient.c:340659`):** `frame_number += framerate·quantum` (`:340690`); for **each integer frame crossed**: accumulate `pos_frames` root motion via `Frame::combine` (`:340713-340720`), `apply_physics` for velocity/omega (`:340723`), and `execute_hooks(animframe, dir)` (`:340726` → `:339683`) which fires footsteps/impacts/particles bidirectionally. On running off a node's last frame it queues `anim_done_hook` (`:340773`) and `advance_to_next_animation` (`:340775`) — and when it runs off the *end of the list*, it wraps to `first_cyclic` (`:340563-340566`). **No weights, no normalization, no crossfade.** Gait is a framerate multiply on the cyclic nodes only (`multiply_cyclic_animation_fr`/`multiply_framerate`, `:339736/340968`); a *negative* multiplier swaps low/high frame for native reverse playback (`:340972` — retail's `?signedMotionSpeed`).

**three.js-equivalent step = the dumb bone-poser.** `CPartArray::UpdateParts` (`acclient.c:326601`) is the *entire* posing operation:
```c
v3 = CSequence::get_curr_animframe(&sequence);            // :326611  = part_frames[floor(frame_number)]  (:339757)
v4 = min(num_parts, animframe->num_parts);                // :326616-326617  (CLAMP)
for (i < v4)  Frame::combine(&parts[i]->pos.frame, world, &animframe->frame[i], &scale);  // :326624
```
For every part, final transform = `world_frame ∘ keyframe_local[i]`, scaled. Discrete frame index, **no interpolation between keyframes, no blend across animations**. `AFrame` (`acclient.h:31629`) = `{position, quaternion}` — *precisely* a three.js `Object3D` `.position` + `.quaternion`. The holtburger flat rig (`part_${p}` children of `root`, `entities.js:3141`) already matches this layout 1:1.

**One tick order — `UpdatePositionInternal` (`acclient.c:319989`):** `CPartArray::Update` fills offset frame (`:320013`) → scale → `adjust_offset` interp-correction (`:320030`) → `Frame::combine` apply to world (`:320031`) → physics/collision (`:320034`) → `process_hooks` drains queued anim hooks *after* position resolve (`:320035`/`:318641`).

**Completion is data-driven, not timer-driven.** `AnimDoneHook::Execute` (`:342336`) → `Hook_AnimDone` (`:317087`) → `CPartArray::AnimationDone` (`:325080`) → `MotionTableManager::AnimationDone` (`:329873`), which bumps `animation_counter` and, per queued motion whose threshold is reached, calls `CPhysicsObj::MotionDone(motion, success)` (`:329894`) — the back-pressure that sequences windup→strike→recover, open→opened, death→corpse correctly. **AnimationDone rides the same hook queue as every other per-frame event.**

**The boundary is already faithful (Part 12) — do not touch it.** `EntityAnimationData` (`src/lib.rs:15510-15567`) is a zero-transform passthrough of DAT-native per-part keyframes, `frameTimes`, `posFrames`, `rootMotionNet`, rest pose, and the sorted hook timeline. `setup_rig.js` already collapsed the formerly ~5 construction sites into one owner. There is no data-faithfulness gap and no second copy of the boundary to unify. **The only thing missing is the authority that consumes this data as a sequence.**

**Target, in one line:** demote `AnimationMixer` from a blend engine to the `UpdateParts` role (a per-part `position`/`quaternion` setter), and move all motion intelligence — which frame, when it ends, what fires, what plays next — into one JS `MotionInterp`/`MotionSequence` per entity, fed by the existing wasm boundary.

---

## 5. Incremental Consolidation Plan

Each step is **independently shippable** (behind a single `?unifiedMotion` capability that can be enabled per-motion-class) and **independently verifiable** (the gate from §7). The order — scaffold → **attack → death → door → cast → locomotion** → hooks/cleanup — front-loads the broken one-shots (highest user-visible payoff) and migrates the working locomotion cycle *last* so it serves as the live regression oracle throughout. Missile rides with attack (same overlay bug, same fix). Where the architecture should live: **build the interpreter in JS** (a new `scene3d/motion/` module or inside `animation.js`, which is the sole wasm↔renderer chokepoint, `entities.js:479`), fed by `animation.js` returning a **sequence descriptor instead of a flat clip**, with `entities.js` hosting the per-entity interpreter + per-part pose write. The wasm boundary stays untouched. (Alternative: host the interpreter in the wasm core, which already owns `SessionCommand::AnimationDone` — noted as an open decision in §8.)

### Step 0 — Scaffolding: the MotionSequence authority + dumb poser (no behavior change yet)
- **Build** a `MotionSequence` per entity (port `CSequence`, `acclient.h:30747`): ordered node list `[link/one-shot] … firstCyclic → [cyclic]`, each node `{animId, lowFrame, highFrame, framerate, sign}` (port `AnimData`, `acclient.h:52536`), with a single `frameNumber` + `currAnim` cursor.
- **Build** the single `advance(dt)` tick (port `update_internal`, `acclient.c:340659`): `frameNumber += framerate·dt`; cross integer frames; at node end carry remainder + `advanceToNextAnimation`; wrap to `firstCyclic` off the end.
- **Build** the dumb poser (port `UpdateParts`, `:326624`): per crossed frame, write `partGroup.children[i].position/.quaternion` directly from `part_frames[floor(frameNumber)]`. No `clipAction`, no weights.
- **Change** `animation.js` to optionally return the `AnimData` chain (segment list) alongside/instead of the pre-concatenated clip (Part 01 rec. 1).
- **Shippable/verifiable:** run in **shadow mode** behind `?unifiedMotion=shadow` — compute the sequence pose for a test entity, compare against the mixer pose numerically in the new headless harness (§7 rec. 1), assert per-bone agreement on a pure-locomotion clip. No production entity switches yet. Gate: headless mixer-vs-sequence parity test green.

### Step 1 — Attack (melee + missile) onto the authority
- **Replace** the `_tryPlayLink` LoopOnce *overlay* (`entities.js:8145`) for attack/cast-class commands with **append-before-`firstCyclic`** in the new sequence (port `337842-337855`: base cycle + one-shot link → wrap back). The swing now drives the whole body by construction; the cycle resumes by list-advance.
- **Fix the missile category error** (Part 09 rec. 2): when the command class is `0x40` (aim-level/Reload) resolve from **`cycles`**, not `links` — the data is already resolvable via the wasm cycle path; only `setSwingMotion`'s links-only `canPlayReal` gate (`entities.js:6039-6043`) blocks it. Sequence `aimLevel → Reload → Ready` as chained nodes (port `Player_Missile.cs` flow). Stop suppressing the server echo when local prediction can't resolve (`picking.js:1150`, `loop.js:2205-2211`).
- **Delete** for the attack class: `setSwingPose` single-bone fallback (`:5603`), `_swingTween` + its ~6 manual-null sites, `_suppressBaseCycleForOverlay` (`:8338`), and the `FULL_BODY_ONE_SHOT` flag (`:592`).
- **Shippable:** `?unifiedMotion=attack`. **Verifiable:** §7 regression guard (a) swing animates the full skeleton, not `parts[13]` only; (b) bow/missile fire produces a non-empty `linkPlays` and a visible draw on a *non-human* rig; numeric per-bone amplitude ≈ authored (not ~50%).

### Step 2 — Death onto the authority
- **Route** `Dead 0x0011` through the `0x40000011` branch of `GetObjectSequence` (`acclient.c:337763-337811`): build one ordered `[collapse link → held cycle]` sequence. **Remove** `0x0011` from `STATIONARY_COMMANDS` (`entities.js:1170`) so it stops being a held LoopRepeat pose racing a separate overlay (Part 08).
- **Couple** the `kind=29` death *event* (`index.html:10151`) and the `Dead` *motion* under the one handler so the body reliably collapses when the server says it died.
- **Shippable:** `?unifiedMotion=death`. **Verifiable:** monster death plays the collapse *then holds its final frame* deterministically (no two-promise race, no STOP-clobber to rest pose); the `coverageByCategory().reaction` / death bucket increments.

### Step 3 — Door onto the authority
- **Replace** the instant `rotation = ±π/2` snap (`index.html:10669-10784`) and the dead `doorRotationRad` scaffold (`buildings.js:420`) with a door open/close motion issued to the same interpreter (Part 07). Doors are `CPhysicsObj`s in retail — zero door-specific code.
- **Requires** the deferred hinge-frame extraction from SetupModel (acknowledged TODO, `index.html:10773-10780`) so the swing pivots correctly instead of "spinning in place."
- **Add** the `CPartArray::Update` half to the static animator (`statics.js`), registering doors + animated statics in one per-frame "animating objects" list (mirror `CPhysics::static_animating_objects`, `acclient.c:311382`).
- **Shippable:** `?unifiedMotion=door`. **Verifiable:** door open/close *interpolates* (not teleports) and the door + building-part stay in sync via one write path; door bucket increments in coverage.

### Step 4 — Cast onto the authority
- **Replace** the `playCastSequence` `setTimeout`-paced JS state machine (`entities.js:5735`) with real sequenced nodes the interpreter advances; timing comes from frame data, subsuming `castSpeed=2.0` (Part 10 rec. 3).
- **Delete** `setCastPose`/`_tickCastTween` (`:5650`/`:6359`) and the four other cast-tween-null sites. **Reframe** `castStateMachine`/`castFizzle` as one motion-queue state (retail gets fizzle/recast/UseDone for free via `MotionDone`, `acclient.c:343641`).
- **Thread `prj_spell_id` on the wire** (open TODO, `entities.js:5871`) so remote casters animate identically to the local player instead of the arms-up vibe pose (`index.html:11350`).
- **Shippable:** `?unifiedMotion=cast`. **Verifiable:** local and remote casts play the same windup chain; fizzle cancels mid-sequence without flashing the success glow; cast bucket increments.

### Step 5 — Locomotion onto the authority (the cycle path, migrated last)
- **Swap** `crossFadeTo`/`fadeOutCurrent` (`entities.js:2139`/`2223`) for the interpreter's cyclic region. Gait becomes one framerate multiply on the cyclic nodes (`multiply_cyclic_animation_fr`, `acclient.c:339736`), eliminating the getter-vs-EMA double-count (`entities.js:10331-10342`) and the negative-timescale reverse hack (use frame-swap).
- **Retire** the integrator-oscillation band-aids: `CROSSFADE_S=0` hard-cut `.time` preservation and `_recentLocomotionTime`/`RESUME_WINDOW_MS` (`:2155-2182`, `:6823-6848`) — `frameNumber` carries phase intrinsically. (Fix the upstream wasm integrator overshoot they mask, `:2162-2175`, in parallel; track as open question §8.)
- **Model sidestep** as a command slot, not a `setEffectiveWeight(0.5)` pose-average (`:7109-7122`).
- **Shippable:** `?unifiedMotion=locomotion` → then graduate `?unifiedMotion` to always-on. **Verifiable:** walk/run/turn/sidestep gait parity vs the prior mixer path (locomotion was the working reference, so this is a pure equivalence check); no foot-pop on W-tap without the phase-preservation hack.

### Step 6 — Hooks, effects, and teardown consolidation (cleanup)
- **Fold** `_tickAnimationHooks`, `_tickHookOmega`, `_tickMaterialHooks`, `_tickScaleHookTween`, and the per-guid `ScriptManager` (`entities.js:10369-10623`) into hooks *emitted by the active sequence* and drained once per frame after position resolve (port `process_hooks`, `acclient.c:318641`). Delete the `setTimeout` walker and the three default-off hook flags.
- **Make AnimationDone one owner:** route all completion through the queued `{kind:"animDone"}` → one `motionDone(motion, success)`, deleting the four ad-hoc completion paths (two mixer `finished` listeners, drain queue, eviction-notify). Finish the inert `notifyAnimationDone` wasm wiring (Part 06).
- **Delete the dead surface:** crossfade branches, `_recentLocomotionTime`, the jump-pose subsystem (fold into a real Jump motion), the flag matrix, the legacy 2D `sprite.rotation` writes.
- **Unify the clock:** one `UseTime(dt)` quantum advances sequence + hooks; retire standalone rAF loops onto `_tweenClockMs` where they touch object motion (leave camera/particles/UI genuinely separate but documented).
- **Verifiable:** full coverage matrix (`coverageByCategory()`) shows `unknown === 0` and every motion class > 0; `stuckEntities()` empty; the line count of `entities.js` motion code drops by the deleted workaround layer.

---

## 6. Per-Type Parity Matrix

From Part 17, verified against source. **Five distinct holtburger mechanisms for eight types; retail has one.**

| Type | Driving path (file:line) | Mechanism class | Observed bug | Retail path (acclient) |
|---|---|---|---|---|
| **Locomotion** (idle/walk/run/turn/sidestep) | `setMotion`→cycle path→`crossFadeTo` (`entities.js:6522`, `6659-6868`, `2139`) | **Unified** (reference path) | Mostly works. Hard-cut `.time`-preservation to avoid foot-pop (`:6809`); LRU evict mid-pause; gait double-count in EMA path (`:10331`). | Re-speeds the running cycle *in place* (`change_cycle_speed`, `:337775`); negative framerate = reverse (`:340972`). No restart, no phase hack. |
| **Melee-attack** | local `picking.js:1255`→`setSwingMotion`→`_tryPlayLink` overlay OR `setSwingPose`; server echo `setMotion`→`:6638`→`:8145` | **Bespoke overlay** | Upper-body only: fallback animates one arm (`:5608`); even the real clip is a LoopOnce overlay blended ~50/50 over the cycle → half-amplitude (`:8330-8337`). | Swing appended before `first_cyclic` in the single `CSequence`; whole body; wraps to stance cycle (`:337842`, `:340566`). |
| **Missile-attack** | `picking.js:1145` fires projectile + `:1147` `setSwingMotion(aimLevel)` else `setSwingPose` | **Bespoke** | Fires with no animation: aim-level *cycle* routed through *links-only* resolver → `canPlayReal` false 100% → single-arm tween / non-human no-op (`:6039-6048`, `:5607`); projectile decoupled. | Launch is a one-shot on the firer's `CSequence`; projectile is its own `CPhysicsObj` flight cycle; same interpreter. |
| **Cast** | `playCastSequence` chains `setSwingMotion` with `sleep` (`:5735`); fallback `setCastPose` (`:5650`); server echo `_tryPlayLink` | **Bespoke JS sequencer on overlays** (most divergent) | First-frame race / missing JSON → 600ms both-arms-up vibe tween; remote casters get no per-spell windup (no SpellId on wire); client/server timing fights without `CAST_SPEED`. | Windup/release is a one-shot via `GetObjectSequence` (`:337842`), chained by `CSequence`, frame hooks fire effects; identical local & remote. |
| **Death** | `setMotion(0x0011)`→`STATIONARY_COMMANDS`→`"walk"`→cycle path (`:1170`, `:6659`); collapse via racy `_tryPlayLink` overlay | **Unified-by-reuse + racy overlay** | Held looping pose, not play-once-then-hold; collapse + held pose are two unsequenced mixer actions racing; MT-miss → bare rest pose silently (`:6760`); no corpse settle; decoupled from `kind=29` event. | One-shot collapse → prone cycle via `first_cyclic` fallback (`:340566`); one mechanism, no death-specific code (`:337799-337810`). |
| **Door-open** | `index.html:10669` instant `rotation=±π/2` snap; OR `setMotion(On/Off)`→`CYCLE_HELD_COMMANDS`→`"walk"` | **Bespoke (no anim)** / unified-by-reuse | Teleports (no interpolation); hinge faked at mesh origin → "spins in place" (`:10773`); 3 parallel rotation writes hand-synced; dead `doorRotationRad` scaffold. | Door is a `CPhysicsObj`; open/close are state commands via the *same* `GetObjectSequence`; hinge baked in keyframes; zero door code. |
| **Jump** | `setAirborne`→`_applyHumanJumpPose`→`_tickJumpPoseTween`; **pauses mixer** (`:5427`, `:5470`, `:6231`) | **Fully bespoke** (bypasses everything) | No MT clip (`0x003B` absent from all 436 retail MTs); hand-coded SLERP; local-player only; 8s stuck-airborne timeout guard. | Launch via `CMotionInterp::jump` (`:344224`); visible motion still a sequence; landing returns to loco cycle. Same `CSequence`. |
| **Emote** | `setMotion`→`EMOTE_COMMANDS`→`"attack"`→`_tryPlayLink` overlay (`:1803`, `:8145`) | **Bespoke overlay** (best-behaved) | Link inner-key needs full 32-bit cmd (`expandActionCommandLow16` `:1865`); idle-fidget stacking guards; missing link → silent no-op. | One-shot action, *indistinguishable in the pipeline from a melee swing* (`:337842`); plays once, returns to stance. |

**Pattern:** holtburger's mechanism count (1 cycle/LoopRepeat, 2 LoopOnce overlay-blend, 3 single-arm tween, 4 both-arms tween + JS sequencer, 5 mixer-bypassing SLERP) maps directly onto the symptom diversity. Retail's high-bit dispatch (`0x80`/`0x40`/`0x20`/`0x10`) routes all eight through one resolver. **This matrix is the §5 migration checklist.**

---

## 7. Verification / Regression-Harness Requirements

The current test surface (Part 18) **cannot catch a consolidation regression and reports GREEN while attack/death/door are 100% untested.** Three structural gaps:

- **The richest signal is built and unused.** `scene3d/diag/motion.js` exposes `onMotionApplied` (`:150`), `onMotionLinkPlayed` (`:230`, captures the attack/cast link path that bypasses `currentActionKey`), `coverageMatrix` (`:310`), `coverageByCategory` (`:383`, buckets into locomotion/swing/cast/emote/reaction/death/door/…), and `stuckEntities` (`:270`). **No test asserts any of it** — grep across all `*.mjs`/`*.cjs` returns zero. It is operator-driven in the devtools console only.
- **The gate tests re-implemented duplicates, not production code.** `entity_anim_targets.test.cjs:4-8` admits it *"can't import scene3d/entities.js … instead we re-implement the small pure contracts. Keep these in sync."* A refactor changing `entities.js` leaves the test green against its stale hand-copy — *the precise mechanism by which a consolidation refactor silently re-breaks motion.*
- **The runtime-tight assertion was deferred and never built** (`test_ac_jump_clip_plays.mjs:16-20`, `test_ac_cast_over_locomotion.mjs:26-31`), the in-browser leg almost never runs (`SERVER_DOWN`/`PLAYWRIGHT_MISSING` → `skip` → folded into GREEN, `run-all.mjs:417-422`), and existing `test_ac_*` anim tests are orphaned from the PLAN and test only the *input* side (which command to pick), never the *output* side (did the rig play it).

**Requirements for the rework:**

1. **Build the deferred headless mixer/sequence harness — no GPU needed.** `AnimationMixer` is pure JS math; instantiate the real interpreter in Node, import the real `entities.js`/`motion/` seam, drive `setMotion`/the sequence, and assert: `frameNumber`/`mixer.time` advances under `update(dt)`; per-bone weight of a swing reaches the **whole** skeleton; the one-shot→cyclic wrap matches retail's `first_cyclic` semantics. This is the never-built "Phase 6.3" and the single highest-value addition. **It is the Step-0 shadow-mode gate.**
2. **A single "motion oracle" parity test as the consolidation spine.** Mirror `GetObjectSequence`: feed `(motion, state)` to both the JS interpreter and the Rust DAT port; assert identical anim-node sequences. *One* test then covers every motion class uniformly — the same property retail gets from having one interpreter. (`getLink` is already ported as a playwright flag.)
3. **Promote `__diag.motion` from console toy to automated assertion.** One in-world descriptor that scripts attack/cast/jump/death/door inputs then asserts via `helpers.readDiag('__diag.motion…')`: `coverageByCategory().swing > 0`, `.cast > 0`, death/reaction `> 0`, door/interaction `> 0`, `unknown === 0`, and `stuckEntities()` (filtered to entities with recent wire events) is empty. The surface already computes all of this; only the assertion is missing.
4. **Explicit regression guards for the four named fragilities**, each mapping to an existing coverage bucket: (a) attack swing animates the full body, not one arm; (b) missile/bow fire plays a clip (non-empty `linkPlays` after a shoot command, on a non-human rig); (c) monster death plays *and holds its final frame*; (d) door open/close interpolates. None of these exists today — grep for `FULL_BODY|suppressBaseCycle|upper.?body|half.?amplitude` and for door/death animation tests returns nothing.
5. **Fold the orphaned `test_ac_*` anim tests into the run-js-headless PLAN** and gate must-exist ones with `--strict-missing` (today a deleted/never-written anim test degrades to GREEN silently, `run-js-headless.mjs:194-195`). Pair each input-side classifier test with an output-side mixer/sequence assertion.
6. **Stop scoring a skipped animation leg as GREEN.** For animation specifically, require the in-world leg to have *run* (≥1 `pass`, not all-`skip`) before green; at minimum surface "anim in-world leg: 0 ran" prominently. Otherwise `SERVER_DOWN → GREEN` hides total non-coverage.

**Per-step gate (used throughout §5):** shadow-mode numeric parity (Step 0) → per-class regression guard (Steps 1–4) → locomotion equivalence check (Step 5) → full coverage matrix `unknown===0` (Step 6).

---

## 8. Open Questions

1. **Where should the interpreter live — JS or wasm?** §5 recommends JS (`scene3d/motion/` or `animation.js`, the sole chokepoint at `entities.js:479`), fed by the faithful boundary. But Parts 12/15 note the wasm core *already owns* `SessionCommand::AnimationDone` (`src/lib.rs:27797`, `:41083`) and references the exact `acclient.c` lines — a wasm-side interpreter would centralize completion natively. **Decision needed before Step 0** (it determines whether `animation.js` returns a sequence descriptor to JS or the wasm side exposes a per-frame pose). *Recommendation: JS-side, because the rig, mixer, and all 34 motion sites are already in JS and the boundary data is sufficient — but confirm with the wasm owner.*

2. **The flag/comment inversion — bug or stale docs?** At least six motion flags (`FULL_BODY_ONE_SHOT` `:592`, `CAST_SPEED` `:608`, `CAST_STATE_MACHINE` `:625`, `castFaceTarget`, `castAxes`, `castFizzle`) are documented "Default OFF … needs a 1070 eye-test" but coded `!== "off"` → **default ON**. *Which is authoritative?* If the fixes are intentionally live, the comments are dangerously misleading; if not, the most invasive mixer workaround is shipping unguarded. A maintainer must confirm before §5 deletes them — and the same `loop.js`/`index.html` default mismatch on `unifiedDispatch` (`loop.js:291` ON vs `index.html:4657` OFF) needs reconciling before any graduation.

3. **The upstream wasm integrator overshoot.** The hard-cut `.time`-preservation and `_recentLocomotionTime` band-aids (`entities.js:2162-2175`) exist to mask a movement integrator that "overshoots the run target (25 m/s vs 4.5 m/s) and oscillates Walk→Stop→Walk sub-second." Step 5 retires the band-aids but **the integrator bug is separate and upstream** — does fixing motion require fixing it first, or does `change_cycle_speed`-in-place tolerate it? Needs a movement-layer owner.

4. **`prj_spell_id` on the wire.** Remote casters can't animate per-spell because `damageTaken` carries no SpellId (`entities.js:5871`, `index.html:11341`). Step 4's remote-cast parity depends on threading it. *Is the wire format frozen, or can ACE add the field?*

5. **Hinge-frame extraction from SetupModel.** Step 3 (doors) is blocked on the deferred hinge extraction (`index.html:10773-10780`). The data is in the DAT but unused. *Scope/owner unknown.*

6. **Vestigial vs. live missile commands.** `MissileAttack1/2/3` (`0xD0-0xD2`) and `Shoot 0x61` are enumerated in `ATTACK_COMMANDS` (`entities.js:1049-1056`) but never dispatched for player bows (ACE broadcasts the aim cycle). Are they live for *creature* missile tables? A DAT audit (`dump_cmt_ranged_rows.rs` exists) should decide whether to wire them via `expandActionCommandLow16` with correct class reconstruction or delete them.

7. **`min`-clamp vs identity-pad at the boundary.** A 2-line parity defect: wasm pads missing parts to identity/origin (`src/lib.rs:16007-16009`) where retail clamps the loop and leaves surplus parts at rest (`acclient.c:326616`). Low priority, rarely hit, but a literal divergence — fold into Step 0 or defer.

8. **Migration-order risk on locomotion-last.** §5 migrates the *working* cycle path last to keep it as the live oracle. The risk: Steps 1–4 build the interpreter's one-shot machinery while locomotion still runs on the mixer, so the two coexist per-entity during rollout. Confirm the shadow-mode harness (rec. 1) can validate a *mixed* entity (sequence one-shots + mixer cycle) before committing, or accept a brief per-class flag-combination matrix during migration.

---

*Synthesis complete. The 18 component reports are unanimous: the fragmentation is the defect, and a ported `CSequence`/`CMotionInterp` sequence interpreter — with `AnimationMixer` demoted to a dumb per-part poser and the existing faithful wasm boundary left untouched — is the structural fix. A ~150-line interpreter plus a per-part pose write replaces several thousand lines of crossfade/overlay/weight/timer logic and collapses the three "independently breaking" systems into one path that is, by construction, the retail path.*
