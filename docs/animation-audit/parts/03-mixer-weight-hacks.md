# Animation Audit — entities.js vs. three.js AnimationMixer (the weight-blend fragility surface)

Scope of this slice: every place `entities.js` *fights* three.js `AnimationMixer` semantics to emulate retail's sequence interpreter. The mixer is a **crossfade / weight-blend engine** (it sums weighted poses of all `enabled + play()`-ed actions); retail `CSequence`/`CMotionInterp` is a **hard frame-pointer walk over one ordered node list**. Almost every hack below exists to make the former behave like the latter.

---

## What exists

The per-entity motion stack is built entirely on `THREE.AnimationMixer` (one mixer per entity, N concurrent `AnimationAction`s keyed in `inst.actions`). On top of it sit four layers of workaround:

| Mechanism | Location | Purpose |
|---|---|---|
| `CROSSFADE_S = 0` | `entities.js:1337` | Globally neuters the crossfade engine → every transition is a hard cut |
| `crossFadeTo()` / `fadeOutCurrent()` hard-cut branches | `entities.js:2139-2258` | Reimplement stop+play with `.time` preservation instead of fading |
| `FULL_BODY_ONE_SHOT` flag + `_suppressBaseCycleForOverlay()` | `entities.js:592-599`, `6130-6142`, `8330-8376` | Ramp base-cycle weight to 0 so a one-shot doesn't blend 50/50 with locomotion |
| `_completeOverlay()` / `_cancelOneShotOverlays()` / evict-notify | `entities.js:8508-8578`, `2284-2291` | Four separate paths to restore the suppressed weight + notify completion |
| Sidestep additive `setEffectiveWeight(0.5)` | `entities.js:7109-7122` | The *one* place the mixer's blend is embraced — contradicts the suppression model |

Retail counterpart (the thing all of this emulates): `CSequence` — one anim-node linked list per `CPhysicsObj`, with `first_cyclic`, `curr_anim`, `frame_number` (`acclient.c:340154` ff), driven by `CMotionInterp::DoMotion` / `CMotionTable::GetObjectSequence`.

---

## How it works (file:line)

### 1. The mixer is told to never crossfade — `CROSSFADE_S = 0` (`entities.js:1337`)
The constant is `0` with the explicit rationale (`1326-1337`): *"retail AC never crossfaded between motions … `advance_to_next_animation()` does an unconditional pointer swap with no blend state."* Every caller passes `CROSSFADE_S`, so:

- `crossFadeTo()` (`entities.js:2139`) takes the `durationS <= 0` branch (`2155-2182`): `currentAction.stop()` then `nextAction.setEffectiveWeight(1.0)` + `enabled = true` + `play()`. It **deliberately skips `nextAction.reset()`** (`2162-2175`) to preserve `.time` so a re-played walk cycle resumes mid-stride instead of rewinding to frame 0 (the "cycle-rewind" workaround for integrator motion-oscillation).
- `fadeOutCurrent()` (`entities.js:2223`) takes its own `durationS <= 0` branch (`2236-2242`): bare `currentAction.stop()`.
- The live-crossfade branches (`2183-2214`, `crossFadeTo(...,durationS,false)`, `fadeIn`, `fadeOut`) are **dead code in production** — retained "for any future caller that overrides the duration" (`2186-2189`).

The single exception is the Ready-stance-change path, which overrides to `0.15s` (`entities.js:6863-6868`) to approximate retail's modifier-stack blend.

There is also a phase-preservation side-table, `_recentLocomotionTime` (`entities.js:2095-2096`, written at `2147-2153` & `2228-2235`, read at `6823-6847`): on swap-out it stashes `action.time`; a same-key re-press within 200ms pins `action.time` back. This is hand-reimplementing `CSequence::frame_number` bookkeeping that the retail interpreter maintains for free.

### 2. One-shot overlays vs. the base cycle — the core weight-ramp hack
When `setMotion` classifies a command as `attack`/`cast` (`entities.js:6638-6657`), it routes to `_tryPlayLink` and **overlays** the swing on the still-running locomotion cycle — *no* crossfade (the legs keep running). Because the mixer sums weighted poses, overlay + base normalize to ~50/50 and "a drudge's overhead smash looks like a wiggle" (`entities.js:587-588`).

The fix is `_suppressBaseCycleForOverlay()` (`entities.js:8338-8376`):
```
8347  const savedWeight = baseAction.getEffectiveWeight()
8350  baseAction.setEffectiveWeight(0);
8351  inst._baseSuppressAction = overlayAction;
...
8362  const onFinished = (e) => { if (e.action !== overlayAction) return;
8371      baseAction.setEffectiveWeight(savedWeight > 0 ? savedWeight : 1.0); }
8374  mixer.addEventListener("finished", onFinished);
```
It is invoked from two sites: the local optimistic swing (`entities.js:6130-6142`) and the server-echo link path (`entities.js:8299`). The local site has a **fragile patch-up** (`6131-6140`): if `_locoCycleKey` wasn't set, it linearly scans `inst.actions` to find the `prior` action and adopts its key as the "base to suppress."

### 3. Four divergent completion/restore paths (retail has one)
The "restore the weight + report done" responsibility is split across mutually-exclusive paths that must never overlap (the comment at `8354-8356` calls out the double-restore risk explicitly):

1. **Listener path** — `onFinished` inside `_suppressBaseCycleForOverlay` (`entities.js:8362-8374`), used when `?hookDrain` is OFF.
2. **Drain-queue path** — `_completeOverlay()` (`entities.js:8508-8527`), used when `?hookDrain` is ON; `_suppressBaseCycleForOverlay` early-returns at `8357-8360` and stashes `_baseSuppressSaved` instead of registering the listener.
3. **Eviction path** — `evictOldestUnused()` calls `notifyMtQueuedOverlayDone(...false)` (`entities.js:2284-2291`) because evicting a never-finished overlay would otherwise hang its Rust-side node forever.
4. **Exit-world teardown** — `_cancelOneShotOverlays()` (`entities.js:8551-8578`) must **manually** restore the weight (`8569-8573`) because `finished` *never fires on `.stop()`*, so the listener's closure (path 1) would leak the `weight = 0` base cycle across a teleport.

### 4. Scattered `setEffectiveWeight` to defeat normalization
`setEffectiveWeight(1.0)` is forced at `2179`, `2192`, `6106` to keep a freshly-played action at full amplitude. The sidestep layer (`entities.js:7109-7122`) goes the *opposite* direction — it intentionally uses `setEffectiveWeight(0.5)` to additively blend strafe + forward into a "midpoint pose which reads as a diagonal walk" (`7110-7113`), cleared via `action.fadeOut(CROSSFADE_S)` i.e. a degenerate zero-duration fade (`7023`).

### 5. Flag-default footgun (live-by-default, documented as off)
`FULL_BODY_ONE_SHOT` (`entities.js:592-599`) reads `get("fullBodyOneShot")?.toLowerCase() !== "off"`. With the param absent this is `undefined !== "off"` → **`true`**. So despite the header comment claiming *"Default OFF … Needs a 1070 eye-test"* (`entities.js:584-591`), the entire base-cycle-suppression machinery is **ON in production**. The same inverted opt-out pattern repeats in `CAST_SPEED` (`608-616`) and `CAST_STATE_MACHINE` (`625-629`), all labelled "default OFF." This means the most invasive AnimationMixer workaround is shipping unguarded while the comments assert it is dormant.

---

## Fragility & workarounds

- **Two code paths per swing keyed on a flag.** `entities.js:6116-6118` does `crossFadeFrom(prior, 0.1)` only when `!FULL_BODY_ONE_SHOT`; when the flag is on it overlays + suppresses. The same swing has two entirely different blending behaviors depending on a URL param the comments wrongly believe is off.
- **`_locoCycleKey` is flag-coupled.** It is reliably assigned only inside the `?velScale=on` branch (`entities.js:6686-6688`). With velScale off, `_suppressBaseCycleForOverlay` falls back to the linear action-scan heuristic (`6131-6140`) or simply finds no base (`8342-8343` early return → no suppression → half-amplitude swing returns).
- **`finished` never fires on `.stop()`.** Any interruption (motion swap, eviction, teleport) leaves the listener closure orphaned with the base cycle pinned at `weight = 0` unless one of the three other paths runs first. This is the structural reason four restore paths exist, and the reason `_cancelOneShotOverlays` has the special "legacySuppressed" detection (`8562-8573`).
- **Double-restore hazard.** The listener (path 1) and drain (path 2) must be mutually exclusive; the only thing preventing a double `setEffectiveWeight` is the `_baseSuppressAction === overlayAction` guard (`8341`) plus the `HOOK_DRAIN_ON` branch (`8357`). Flip both flags inconsistently (the doc admits they're "independently flippable", `8233-8236`) and ordering parity breaks.
- **Spam-click duplicate listeners.** Guarded ad-hoc per mechanism: `_baseSuppressAction` (`8341`), `__mtNotifyArmed` (`8231-8245`), `_pendingRootMotion` (`8400-8405`) each separately defend against the reused-action-replay registering stacked `finished` listeners.
- **Restore-timer races the mixer.** The swing auto-restore is a `setTimeout` re-issuing `setMotion(CMD_LOW_READY)` (`entities.js:6190-6199`) — a wall-clock timer racing the mixer's own clip-end, guarded by `currentActionKey !== swingKey` re-checks (`6162`, `6197`).
- **"Missiles fire with no animation" / "monster-death breaks independently"** are downstream of the same architecture: a missing `MotionTable` link makes `_tryPlayLink` return early with only a console warning (`entities.js:8169-8191`, *"swing/cast/eat will not play"*). Because there is no single sequence authority, each clip type fails in isolation — exactly the "break independently, need weeks of rework" symptom.
- **Degenerate fades.** `fadeOut(CROSSFADE_S)` with `CROSSFADE_S = 0` (`7023`) and `fadeIn(durationS)` only when `durationS > 0` (`2210-2212`) — the fade API is being called with the one argument value that makes it a no-op, a tell that the wrong engine is in use.

---

## Retail (acclient) comparison

Retail has **one** motion authority per object — `CSequence` — and the one-shot/cyclic distinction is handled *inside the sequence*, so the 50/50-blend problem this file fights **does not exist** in retail.

**Setting a new motion** — `CMotionTable::GetObjectSequence` (`acclient.c:339023` `DoObjectMotion` → body at `337720`+):
```
337736  CSequence::clear_physics(sequence);
337737  CSequence::remove_cyclic_anims(sequence);     // drop the looping region
337738  add_motion(sequence, pre_link, speed_mod);    // prepend transition link (one-shot)
337739  add_motion(sequence, motiona, speed_mod);
337740  add_motion(sequence, link2, speed_mod);
337741  add_motion(sequence, link, speed_mod);         // append new cyclic
```
One-shot link anims are **prepended ahead of `first_cyclic`**; the new cyclic is appended. `CSequence::append_animation` sets `first_cyclic = tail` (`acclient.c:340624`).

**Per-frame advance** — `CSequence::advance_to_next_animation` (`acclient.c:340473`):
```
340563  if ( AnimSequenceNode::GetNext(*_curr_anim) )
340564      *_curr_anim = GetNext(*_curr_anim);        // walk forward, node by node
340565  else
340566      *_curr_anim = this->first_cyclic;          // run off the end → wrap to cyclic
```
So the interpreter walks the prepended one-shots **once**, and when it falls off the end it wraps into the cyclic region and loops there forever. There is **no weight, no blend, no normalization** — `update_internal` (`acclient.c:340659`) just advances `frame_number` by `quantum × framerate` and pointer-swaps nodes. `remove_cyclic_anims` (`acclient.c:340154`) excises the loop region when a new motion arrives, fixing up `curr_anim`/`frame_number` as it goes.

**Mapping the hacks to what retail actually does:**

| holtburger workaround | retail equivalent | gap |
|---|---|---|
| `_suppressBaseCycleForOverlay` weight→0 then restore on `finished` | `remove_cyclic_anims` then `add_motion` re-adds the cyclic (`acclient.c:337737-337741`) | retail removes the cyclic *node from the list*; it never coexists with the one-shot, so there's nothing to ramp |
| `CROSSFADE_S = 0` hard cut + `.time` preservation | `advance_to_next_animation` pointer swap + `frame_number` (`acclient.c:340563`, `340659`) | holtburger reinvents frame bookkeeping the sequence owns natively |
| `FULL_BODY_ONE_SHOT` = "play one-shot on top of base" | not a mode — retail one-shots are *prepended in the same list* and always full-body | the flag toggles between two wrong approximations of one correct behavior |
| 4 completion/restore paths | one event: `CPartArray::AnimationDone` → `MotionTableManager::AnimationDone` (`acclient.c:325080`, `329873`; success hard-coded 1 on renderer path, `317093`) | holtburger has no single completion owner |
| `_cancelOneShotOverlays` manual teardown | `MotionTableManager` exit/enter-world drain: `remove_all_link_animations` + `AnimationDone(0)` per pending (`acclient.c:329940-329957`) | already cited by the code (`8531-8545`); the JS version must hand-restore weight because there's no sequence to clear |
| sidestep `setEffectiveWeight(0.5)` additive blend | sidestep is a separate command **slot** in the same interpreted state (`acclient.c:332759-332786`), played as its own sequence node — not a 50/50 pose average | the 0.5 "midpoint pose" is an artifact retail never produced |
| `_motionSpeed` × `setEffectiveTimeScale` | `AnimSequenceNode::multiply_framerate` / `CSequence::multiply_cyclic_animation_fr` (`acclient.c:340968`, `339736`) | this one is a faithful analog |

---

## Consolidation recommendations

1. **Stop using `AnimationMixer` as a blend engine; make it a clip sampler under one sequence scheduler.** Introduce a single `CSequence`-equivalent per entity: an ordered list of nodes (prepended one-shot links + a trailing cyclic region with a `firstCyclic` marker), advanced by one clock, sampling exactly **one** clip at a time. This collapses items #1–#4 of *What exists* into the architecture retail already proved. The mixer stays only as the keyframe interpolator for the single active node.

2. **Delete the crossfade machinery and `CROSSFADE_S`.** With a sequence walker, the hard-cut branches, the dead live-crossfade branches (`2183-2214`), the `_recentLocomotionTime` phase side-table (`2095-2096`, `6823-6847`), and the `.time`-preservation comments all disappear — `frame_number` carries the phase intrinsically (`acclient.c:340659`). Keep the one 0.15s Ready-stance blend only if a deliberate visual choice, but model it as a node fade-duration, not a global-constant exception (`6863-6868`).

3. **Remove `FULL_BODY_ONE_SHOT` entirely and fix the flag-default footgun.** Full-body one-shot is the *only* retail-correct behavior, so it should not be a toggle. Eliminate the `!FULL_BODY_ONE_SHOT` divergent swing path (`6116-6118`) and the whole `_suppressBaseCycleForOverlay` weight-ramp — in a sequence model the locomotion node is simply not active while the one-shot node plays. Separately, audit the `?x=on / !== "off"` inversion across `592`, `608`, `625`: these ship ON while documented OFF; either correct the comments or the predicate, but do it knowingly.

4. **Collapse the four completion paths into one event.** Mirror `AnimationDone` (`acclient.c:325080`/`329873`): the sequence scheduler emits exactly one "node finished / sequence drained" signal that does weight-restore (gone, per #3), hook-completion notify, and root-motion apply. This removes the listener-vs-drain mutual-exclusion hazard (`8354-8356`), the stop()-doesn't-fire-finished class of bugs, and the duplicate guards (`_baseSuppressAction`, `__mtNotifyArmed`, `_pendingRootMotion`).

5. **Decouple base-cycle identity from `?velScale`.** `_locoCycleKey` must be an explicit property of the sequence (the cyclic region), not a field set only inside the velScale branch (`6686-6688`) with a linear-scan fallback (`6131-6140`).

6. **Model sidestep as a command slot, not a 0.5-weight blend.** Retail carries forward/sidestep/turn as independent slots in `InterpretedMotionState` (`acclient.c:332759-332786`); the `setEffectiveWeight(0.5)` average (`7109-7122`) is an approximation retail never rendered. Fold it into the sequence model as a concurrent slot resolved to a real clip.

7. **Make missing-link failures loud and centralized.** The `_tryPlayLink` silent-warning early-return (`8169-8191`) is why missiles/deaths "break independently." A single sequence authority gives one place to detect and surface a missing `MotionTable` link instead of per-clip-type silent drops.

**Net:** every hack in this file is a local patch over the same root cause — three.js plays N actions concurrently and weight-normalizes them, while retail plays one ordered sequence with no blend. Porting the `CSequence` prepend-one-shot / wrap-to-cyclic contract (`acclient.c:337737-337741`, `340563-340566`) replaces the entire `FULL_BODY_ONE_SHOT` / `_suppressBaseCycleForOverlay` / `CROSSFADE_S=0` / four-restore-path surface with one deterministic interpreter.
