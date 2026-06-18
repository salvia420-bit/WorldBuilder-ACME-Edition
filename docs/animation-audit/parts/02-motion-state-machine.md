I have everything I need. Here is the audit.

---

## What exists

The motion "state machine" for every non-local animated entity lives entirely inside `EntityManager`/`EntityInstance` in `external/holtburger/apps/holtburger-web/scene3d/entities.js` (12,555 lines). It is **not** a single interpreter — it is a three.js `AnimationMixer` plus a scatter of imperative entrypoints that each independently push clips at the mixer.

The persistent per-entity motion state is just **four scalars and a clip cache** (`entities.js:2002-2010`):

- `inst.currentAction` — the one `THREE.AnimationAction` treated as "playing."
- `inst.currentActionKey` — its cache key string, used for the "already playing?" no-op test.
- `inst.actions: Map<cacheKey, AnimationAction>` — LRU clip cache, capped at `MAX_ACTIONS_PER_SETUP = 4` (`entities.js:1324`).
- `inst.lastStance` / `inst.currentStance` — stance tracked redundantly in two fields (+ `inst.meta.motionStance` as a third fallback).

Around that core sit **~10 entrypoints that all mutate or bypass the "current" pointers**, plus **two fake-pose tween systems** (`_swingTween`, `_castTween`) and **a separate sidestep overlay layer** — none of which is the single authority.

The central dispatcher is the free function `classifyMotionCommand(cmd)` (`entities.js:1745-1828`), which collapses the entire AC `MotionCommand` enum into six strings — `"stop" | "walk" | "run" | "attack" | "cast" | "idle" | null` — that in turn collapse into just **two playback shapes**: a LoopRepeat *cycle* (crossFadeTo) or a LoopOnce *overlay* (`_tryPlayLink`).

---

## How it works (file:line)

**Command → clip, the happy path (`setMotion`, `entities.js:6522-6885`):**

1. **Wire rewriting** before classification: `Stop`/`Invalid → Ready` (`6549-6552`); `TurnLeft → TurnRight` (`6567-6569`); `SideStepLeft → SideStepRight` (`6570-6573`); `stance==0 → inst.lastStance` (`6590-6594`). Stance is then mirrored onto `inst.currentStance` (`6601`).
2. **Classify**: `const cls = classifyMotionCommand(cmd)` (`6602`). `classifyMotionCommand` is a static cascade over `cmd & 0xffff` against nine hardcoded `Set`s — `ATTACK_COMMANDS` (`1042`), `CAST_COMMANDS` (`1073`), `EMOTE_COMMANDS`, `REACTION_COMMANDS`, `INTERACTION_COMMANDS`, `IDLE_AMBIENT_COMMANDS`, `EXTENDED_ATTACK_COMMANDS`, `STATIONARY_COMMANDS`, `CYCLE_HELD_COMMANDS` — every one of which folds into either `"attack"` (overlay) or `"walk"` (cycle) (`1803-1809`).
3. **Branch by class:**
   - `"stop"`/`null` → `inst.fadeOutCurrent(CROSSFADE_S)` and return (`6603-6611`).
   - `"attack"`/`"cast"` → `this._tryPlayLink(inst, setupId, mtableId, READY_SUBSTATE, linkCmd, stance)` and return (`6638-6657`). **This path never touches `currentActionKey`** — the swing is played raw under a `link:` key (`8195`).
   - locomotion (`"walk"`/`"run"`/`"idle"`) → build `cacheKey = AnimationCache.makeKey(setupId, mtableId, cmd, stance)` (`6661`); if `cacheKey === inst.currentActionKey` return (the only idempotency guard, `6700`); else async-fetch the clip (`6735`) and `inst.crossFadeTo(action, cacheKey, crossfadeDuration)` (`6868`).

**The "crossfade" is hard-cut.** `CROSSFADE_S = 0` (`entities.js:1337`), so `crossFadeTo` (`2139-2217`) almost always takes the `durationS <= 0` branch (`2155-2182`): `currentAction.stop()` then `nextAction.play()` — no blend. The lone exception is a stance change on the `Ready` cycle, hardcoded to `0.15s` (`6863-6867`). So the `AnimationMixer`'s crossfade/weight-blend engine is deliberately disabled almost everywhere (comment: "retail had no blend between motions," `2156`).

**Overlay path (`_tryPlayLink`, `entities.js:8145-8328`):** fetches a MotionTable *link* clip for `(stance, from→to)`, installs it under key `link:{from}->{to}:{stance}` (`8195`), `setLoop(LoopOnce)`, `clampWhenFinished=false`, `action.reset(); action.play()` (`8261-8262`). It deliberately does **not** stamp `currentAction`/`currentActionKey`, so the swing coexists with whatever cycle is current via mixer weight-blending. A missing link entry resolves to a null clip and **silently no-ops** with only a `console.warn` (`8169-8191`).

**Stance tracking is multi-sourced.** Reads use `??` fallback chains in at least five places: `inst.currentStance ?? inst.lastStance ?? inst.meta?.motionStance ?? 0` (`5339`, `5934`, `6020`, `6932`, `9932`). Writes happen inline in `setMotion` (`6590-6601`), with separate logic in `setLocalStance` (`6924-6953`) and a third derivation through `window.__getCurrentStanceLow()` in `cancelCastSequence` (`5934-5935`). No invariant forces the three fields to agree.

**Every site that writes the "current" pointers** (`currentAction`/`currentActionKey`):
- constructor null-init (`2009-2010`)
- `crossFadeTo` (`2215-2216`) — the supposed owner
- `fadeOutCurrent` (`2256-2257`)
- `dispose` (`2356-2357`)
- spawn auto-play, stamped **directly, bypassing crossFadeTo** (`3327-3328`)
- `setSwingMotion`, stamped **directly** (`6123-6124`)

…and `_tryPlayLink`, `setSidestepLayer` (`6995`), `setSwingPose`/`setCastPose` (`5603`/`5650`), and `playCastSequence` (`5735`) all play clips/poses that bypass the pointers entirely.

---

## Fragility & workarounds

Concrete, cited:

1. **A blend engine configured not to blend.** `CROSSFADE_S = 0` (`1337`) turns the `AnimationMixer` into a single-clip player. The `crossFadeTo` method carries three code paths (hard-cut / live-crossfade / fresh-start, `2155-2214`) of which only the hard-cut runs in production — dead complexity kept "for any future caller" (`2188`).

2. **"Attacks only swing the upper body."** Attack/cast go through `_tryPlayLink` as an overlay that does **not** suppress the base locomotion/Ready cycle. three.js normalizes overlay + base to ~50/50 weight, so the swing plays at half amplitude and the legs keep cycling. The fix — `_suppressBaseCycleForOverlay` ramping the base cycle's weight to 0 (`8330-8344`, fired at `8298-8300`) — is gated behind `FULL_BODY_ONE_SHOT`, a **default-off URL flag** (`592`). Default behavior is still the half-body swing.

3. **"Missiles fire with no animation."** `MissileShoot 0x0061` and `MissileAttack1/2/3 0x00D0-0x00D2` are in `ATTACK_COMMANDS` (`1050`, `1056`) → classify `"attack"` → `_tryPlayLink`. If the entity's MotionTable lacks a link for `(stance, cmd)`, the overlay resolves to a null clip and **silently no-ops** (`8169-8191`) — the shot is invisible. There is no animation fallback: the only fallback, `setSwingPose`, early-returns on non-humans (`5607`) and just rotates the **right upper arm** (`5608-5616`) — it never models a bow draw/loose. Missile fire that doesn't hit an exact link is dropped.

4. **Two parallel fake-pose systems that must be manually un-stuck.** `_swingTween` (`5618`) and `_castTween` (`5670`) are triangle-wave quaternion tweens applied *after* `mixer.update` (`_tickSwingTween`), so they overwrite the real clip's arm pose unless explicitly nulled. They are cleared defensively in ~6 scattered places (`6122`, `6643`, `6647`, `6781`, `6785`, `5931`) — every new real-clip path must remember to kill them or the placeholder fights the real animation.

5. **Stance redundancy.** Three fields (`currentStance`/`lastStance`/`meta.motionStance`), no single writer, read through `??` chains in five+ locations (above). `setLocalStance` exists solely to reconcile the predictor-owned local rig against the server's stance half of `UpdateMotion` because the normal echo is skipped (`6887-6953`) — a special case bolted on because there's no unified state.

6. **4-clip LRU causes foot-pop, worked around by phase-stashing.** `MAX_ACTIONS_PER_SETUP = 4` (`1324`); `evictOldestUnused` (`2265-2284`) can drop a walk clip mid-pause, so a re-press creates a fresh action at `.time = 0` and the feet snap. Worked around by `_recentLocomotionTime` stashing `mixer.time` on every swap-out (`2147-2153`, `2228-2235`) and restoring within a 200ms window (`6823-6848`).

7. **Fighting an upstream integrator bug at the animation layer.** `crossFadeTo` deliberately skips `.reset()` to preserve `.time` because the wasm movement integrator oscillates `Walk→Stop→Walk` at sub-second cadence and would otherwise rewind the walk cycle to frame 0 every tick (`2162-2175`). The animation layer is compensating for a movement-layer defect.

8. **Death and doors are modeled as held cycles, not transitions.** `Dead 0x0011` is in `STATIONARY_COMMANDS` (`1170`) → `"walk"` → LoopRepeat "held slumped pose" (comment `1164-1165`). Door `On 0x000B`/`Off 0x000C` are "object-state cycles" (`1294`) routed the same way. There is **no concept of a death *collapse* transition or a door *swing*** in the classifier — they are looping poses, which is why these animations "break independently" and have no shared transition machinery. Anything the nine Sets don't name returns `null` → `fadeOutCurrent` (frozen rest pose) unless the default-off `MT_CLASS_FALLBACK_ON` flag (`660`, `1815-1826`) coarsely guesses a play-kind from the class byte.

---

## Retail (acclient) comparison

Retail has exactly the single authority this code lacks. (Citations from the parallel `acclient.c`/`.h` survey.)

| Concern | Retail (acclient) | holtburger entities.js |
|---|---|---|
| **State owner** | One `CMotionInterp` per object (`acclient.h:31407-31420`) holding `RawMotionState raw_state` + `InterpretedMotionState interpreted_state`. | Two scalars `currentAction`/`currentActionKey` (`2009-2010`) written from 6+ sites, plus 3 stance fields. |
| **Motion decomposition** | `RawMotionState`/`InterpretedMotionState` carry independent `forward_command`, `sidestep_command`, `turn_command` (+holdkey+speed each) and an `actions` list (`acclient.h:31372-31399`). | Single `currentActionKey` clip for forward; sidestep bolted on as a separate overlay action (`setSidestepLayer`, `6995`); turn folded into forward via Left→Right rewrite; "actions" are fire-and-forget overlays with no list. |
| **Cmd → animation** | `CMotionTable::GetObjectSequence` (`acclient.c:337641+`) reads `cycles`, `links`, `style_defaults`, `modifiers` hashes and **builds a `CSequence`** — an ordered list of `AnimSequenceNode` frames. | `classifyMotionCommand` (`1745`) buckets into 2 shapes, then a single clip is fetched and `.play()`'d. No sequence; nine hardcoded `Set`s stand in for the motion table's structure. |
| **Playback** | `CSequence::update_internal` (`acclient.c:340659-340780`): strictly sequential frame advance, `frame_number += framerate * quantum`; **no weight-blending, no crossfade.** Transitions are pre-authored *link* animations chained into the sequence. | three.js `AnimationMixer` weight-blend engine, then disabled (`CROSSFADE_S=0`) to *emulate* the no-blend behavior — the overlay path still relies on blending (and suffers the 50/50 half-body bug). |
| **Chaining (stance→attack)** | One `CSequence` built with link transitions; `pending_animations`/`pending_motions` queue (`acclient.h:31104`, `:53293`) sequences motions and reports completion deterministically. | No queue. `_tryPlayLink` + `lastMotionCommand` (`6711`, `6725`) approximate links as racing async fetches with no ordering or completion contract. |
| **Stance** | `current_style` is one field, atomically swapped inside the interpreter (`acclient.c:332771-332786`). | `currentStance`/`lastStance`/`meta.motionStance`, three sources reconciled ad hoc. |

The decisive divergence: retail resolves *(style, command)* into **one ordered frame sequence through one code path** and advances it linearly. holtburger resolves a command into **one of two ad-hoc playback shapes through ~10 entrypoints**, layering independent clips/tweens on a blend engine it has to keep disabling. The fragmentation *is* the bug class — each animation family (locomotion, swing, cast, death, door) lives on a different sub-path, so each "breaks independently."

---

## Consolidation recommendations

1. **Introduce one `MotionInterp` per entity as the sole state owner.** Mirror `CMotionInterp`: a single object holding an interpreted state of `{ style, forward, sidestep, turn, actions[] }`. Every external caller (`setMotion`, `setSwingMotion`, `setSidestepLayer`, `setLocalStance`, `playCastSequence`, spawn) becomes a thin mutator of that state; nothing else writes `currentAction`/`currentActionKey`. Eliminate the two direct stamps at `3327-3328` and `6123-6124`.

2. **Collapse stance to one field.** Replace `currentStance`/`lastStance`/`meta.motionStance` with `interp.style`. Delete the `??`-chain reads (`5339`, `5934`, `6020`, `6932`, `9932`) and the bespoke `setLocalStance` reconciliation (`6924`).

3. **Resolve commands to a sequence, not a class string.** Replace `classifyMotionCommand`'s nine `Set`s (`1042-1230`) and the six-string output with a motion-table-driven resolver that returns an ordered clip sequence per *(style, command)* — the wasm side already exposes the MotionTable (`fetchEntityAnimationKeyframes`, `lookupMotionLinkForSwing`). This makes death, doors, missiles, and swings the *same* path: a sequence lookup that either resolves or doesn't, with one fallback policy.

4. **Make one-shots full-body by default and sequence them, not overlay them.** Promote `_suppressBaseCycleForOverlay` (`8330`) from the default-off `FULL_BODY_ONE_SHOT` flag to the default: a swing/cast/death/door transition should *replace* the cycle for its duration and chain back, the way `CSequence` chains a link then resumes the cyclic node — not weight-blend at 50/50. This directly fixes "attacks only swing the upper body" and "missiles fire with no animation" (the loose becomes a sequenced full-body clip with a real fallback).

5. **Add a completion-ordered queue.** Adopt the `pending_animations` model (`acclient.h:31104`) so stance→attack and multi-strike chains play in order with a real "animation done" signal, replacing the fire-and-forget `_tryPlayLink` + timer restores (`5989`, `6792`) and the `_swingRestoreTimer`/`_castSequenceToken` ad-hoc completion tracking.

6. **Retire the two vibe-tween systems.** Once every command resolves through the sequence path with a defined fallback, `_swingTween`/`_castTween` (`5603`-`5676`) and their six manual-clear sites become dead code. Deleting them removes the "placeholder fights the real clip" failure mode entirely.

7. **Keep `CROSSFADE_S=0` as policy, but own it in one place.** The no-blend decision is correct per retail; encode it once in the new interpreter's sequencer rather than re-deriving it across `crossFadeTo`, `fadeOutCurrent`, the spawn path, and the overlay path. Then the dead crossfade branches (`2183-2214`) can go.

The throughline: retail is fragile-proof because *one* interpreter turns *every* `(style, command)` into *one* sequence on *one* playback path. Porting that single-authority shape — not incrementally patching the ~10 current entrypoints — is what ends the piecemeal animation system.
