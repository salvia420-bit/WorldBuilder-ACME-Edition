I have a complete, concretely-cited picture of both the holtburger locomotion code and the retail interpreter. Here is the audit.

---

# Locomotion Audit — `scene3d/entities.js` (walk/run/idle, gait, `_locoCycleKey`, `cycleTimeScale`, cycle crossfades, base↔overlay)

## What exists

Locomotion in the browser client is **not a motion system** — it is a set of loosely-coupled writers that all push pose onto a per-entity `THREE.AnimationMixer`. For the locomotion slice specifically, the moving parts are:

- **`classifyMotionCommand(cmd)`** — a flat string classifier mapping a 32-bit MotionCommand → `"walk" | "run" | "idle" | "attack" | "cast" | "stop" | null` (`entities.js:1745-1828`).
- **`setMotion(guid, cmd, stance, motionSpeed)`** — the locomotion entry point: classify → build a cache key → async-fetch a clip → `crossFadeTo` it (`entities.js:6522-6885`).
- **`crossFadeTo` / `fadeOutCurrent`** — the per-instance action swap, *hard-cut by default* (`entities.js:2139-2258`).
- **`cycleTimeScale(actual, base)`** — a pure anti-ice-skating gait factor in a *separate* module (`animation.js:269-281`).
- **The per-frame `tick()` velScale block** — recomputes the gait `setEffectiveTimeScale` every frame from an EMA *or* a wasm `stateGroundSpeed` getter (`entities.js:10246-10353`).
- **`_locoCycleKey` / `_locoBaseSpeed`** — per-entity pointers identifying "which cached action is the active loco cycle" and its authored speed (`entities.js:6687-6688`, `6400`).
- **One-shot overlay path** — `setSwingMotion` / `_tryPlayLink`, plus `_suppressBaseCycleForOverlay` / `_completeOverlay` to ramp the base cycle's weight to 0 while a swing/cast plays (`entities.js:6090-6207`, `8330-8527`).
- **Idle**: spawn auto-plays the Ready cycle LoopRepeat (`entities.js:3315-3329`); `_idleFidgetTick` bolts random emote overlays on top of a standing idle (`entities.js:10674-10728`).

The behavior is fragmented further by **~14 URL feature flags**, several governing core locomotion correctness and defaulting OFF pending "a 1070 eye-test": `?velScale` (`:526`), `?signedMotionSpeed` (`:575`), `?fullBodyOneShot` (`:592`), `?tweenClock` (`:560`), `?gaitHz` (`:1412`), `?castSpeed` (`:608`), `?cycleOmega`, `?mtClassFallback` (`:1815`), `?hookDrain`, `?mtQueue`, `?rootMotionObject`, `?deadReckon`, `?smoothStride`, `?dynLod`.

## How it works (file:line)

**Dispatch / classification.** `setMotion` masks the wire command's low 16 bits and runs `classifyMotionCommand` (`entities.js:6602`, `1745`). STOP (`0x0004`) and Invalid (`0x0000`) are rewritten to Ready `0x0003` so a halting entity holds a stance pose instead of rest pose (`entities.js:6549-6552`). Walk-back/sidestep/turn/fall-cycle commands are all folded into `"walk"` (`entities.js:1748-1781`) so they route through the same cyclic path; Left codes are rewritten to Right (`entities.js:6567-6573`).

**Cycle resolution & swap.** The cache key is `setupId:mtableId:cmd:stance` (`entities.js:6661`). On a hit/miss the action is configured `LoopRepeat, Infinity` for locomotion (`entities.js:6787`) and handed to `crossFadeTo(action, key, dur)` (`entities.js:6868`). `CROSSFADE_S = 0` (`entities.js:1337`), so `crossFadeTo` takes the **hard-cut branch**: `currentAction.stop()` then `nextAction.play()` with **no `reset()`** so `.time` is preserved across the swap (`entities.js:2155-2182`). The live-crossfade branch (`crossFadeTo(next, dur, false)`) is retained but **dead in production** (`entities.js:2183-2203`). The *only* real cycle-to-cycle blend is a special-cased 150 ms fade when Ready is re-resolved with a changed stance (`isStanceReadyChange`, `entities.js:6863-6868`).

**Gait / `cycleTimeScale`.** Two speed inputs feed one playback-rate factor:
- `base` ← `_resolveCycleBaseSpeed` async wasm `cycleBaseSpeed` (|MotionData.velocity|), stashed on `_locoBaseSpeed` only if the cycle is still current when it resolves (`entities.js:6387-6401`).
- `actual` ← `_resolveStateGroundSpeed` synchronous wasm `stateGroundSpeed` (retail `get_state_velocity` mirror), falling back to an **EMA over rig XZ position deltas** when the getter is absent/null (`entities.js:6451-6502`, `10326-10330`).

Each frame, **before `mixer.update`**, the velScale block samples the EMA (α=0.3, `entities.js:10282-10283`), then if `base > 0 && _locoCycleKey` and `locoAction.isRunning()`, computes `cycleTimeScale(actual, base)` clamped to `[0.25, 4.0]` and calls `locoAction.setEffectiveTimeScale(...)` (`entities.js:10337-10350`). `?gaitHz` optionally throttles only the *recompute* (`entities.js:10298-10308`). `?signedMotionSpeed` negates the final scale for backstep reverse playback (`entities.js:10347-10349`).

**Base ↔ one-shot overlay.** Attack/cast never go through the cycle path — they route to `_tryPlayLink` as `LoopOnce` overlays that play *on top of* the still-running loco cycle (`entities.js:6622-6657`, `6778-6789`). With `?fullBodyOneShot=off` (the default) the overlay and base both have weight 1, so **three.js normalizes them to ~50/50** (`entities.js:584-591`). With the flag ON, `_suppressBaseCycleForOverlay` reads `_locoCycleKey`, saves the base action's weight, sets it to 0, and restores it on the overlay's `finished` event — *or*, under `?hookDrain`, via `_completeOverlay` off a drain queue (the two are mutually exclusive to avoid a double-restore) (`entities.js:8338-8375`, `8508-8527`).

**Phase preservation.** `crossFadeTo`/`fadeOutCurrent` stash the departing action's `.time` in `_recentLocomotionTime`; a same-key re-press within `RESUME_WINDOW_MS = 200` restores it so feet don't pop to frame 0 (`entities.js:2147-2153`, `6823-6848`).

**Idle.** Spawn just `.play()`s the Ready LoopRepeat action (`entities.js:3324-3329`). `_idleFidgetTick` accumulates dwell while on idle with |v|≈0 and no overlay, then probes a random ChatEmote command and plays it as a LoopOnce overlay (`entities.js:10674-10728`, commands at `:755-764`).

## Fragility & workarounds

1. **No single authority — at least 7 independent rig writers.** `setMotion` (cycles), `setSwingMotion`/`_tryPlayLink` (overlays), the per-frame velScale gait recompute, four wall-clock pose tweens (`_tickSwingTween`/`_tickJumpPoseTween`/`_tickCastTween`/`_tickScaleHookTween`), `_idleFidgetTick`, and `_tickHookOmega` all mutate the same mixer/root each frame, in an order the code has to manually keep straight (e.g. tweens run *after* `mixer.update` to "win", `entities.js:6225-6230`). This scattering is the root cause of "monster-death/door animations break independently" — there is no shared sequence state, so each effect's lifecycle (start, blend, finish, restore) is hand-managed in isolation.

2. **The exact "upper-body-only attack" bug is real and the fix is flag-gated OFF.** Default `?fullBodyOneShot=off` ⇒ overlay + base cycle normalize to ~50/50 ⇒ "a drudge's overhead smash looks like a wiggle, then pops to the base pose in one frame at clip end" (`entities.js:584-591`). The full-body fix exists but is opt-in and "Needs a 1070 eye-test" (`:591`). Same mechanism degrades missile-shoot and cast overlays.

3. **Gait math has two code paths with different correctness, one admittedly wrong.** Getter path applies forward_speed once; EMA-fallback path multiplies by `_motionSpeed` again — the comment concedes "the EMA path likely double-counts too; revisit when flipping VEL_SCALE_ON on" (`entities.js:10331-10342`, `10321-10325`).

4. **velScale is inert by design until an upstream bug is fixed.** "velScale only scales an already-running loco cycle, so it stays inert until the stuck-in-idle/walk-run dispatch gap is fixed" (`entities.js:524-525`). The gait fix is gated on a dispatch defect elsewhere.

5. **Hard-cut + `.time` preservation is a workaround for an integrator bug.** `crossFadeTo` deliberately skips `reset()` because the wasm integrator "overshoots the run target (25 m/s vs 4.5 m/s)" and oscillates Walk→Stop→Walk sub-second; resetting would rewind the cycle to frame 0 every stutter (`entities.js:2162-2175`). `_recentLocomotionTime`/`RESUME_WINDOW_MS` is a second band-aid over the same oscillation (`entities.js:2081-2096`).

6. **Overlay completion is split across two mutually-exclusive mechanisms.** A mixer `finished` listener vs. the `?hookDrain` drain queue, with an explicit "must be mutually exclusive or the weight double-restores; spec S5 §5 risk 5" warning (`entities.js:8352-8360`, `8508-8525`). Interrupted overlays never fire `finished`, so root-motion/weight-restore "applies NOTHING" — an accepted gap vs retail's per-frame partial application (`entities.js:8388-8391`). This is precisely how a death/door overlay can leave a rig in a wrong pose.

7. **Cross-reach via `_locoCycleKey` with stale-state risk.** STOP returns early (`entities.js:6603-6610`) without clearing `_locoCycleKey`/`_locoBaseSpeed`; overlay suppression then reads a possibly-stale base key, guarded only by `isRunning()` checks and a fallback "find prior action" loop (`entities.js:8342-8346`, `6131-6139`). `_locoCycleKey` is only set in the velScale branch, so `fullBodyOneShot` needs a fixup loop when velScale is off (`entities.js:6131-6139`).

8. **Two clock domains.** Mixer + hooks advance on clamped dt; the four pose tweens read `performance.now()` wall clock — a tab-throttle desyncs tweens from clip state. `?tweenClock=dt` unifies them but is OFF by default (`entities.js:537-567`).

9. **Idle realism is a probe-and-guess bolt-on.** There's "NO wasm getter to ENUMERATE the idle/fidget motions a MotionTable contains", so `_idleFidgetTick` plays a *randomly chosen* emote and hopes the MT has a link for it (`entities.js:10664-10671`). Retail's idle variations are authored sequence data, not a JS heuristic.

## Retail (acclient) comparison

Retail has **exactly one motion authority** per animated object — `CSequence` driven by `CSequence::update_internal` — and *everything* (locomotion, attacks, casts, doors, monster death, idle variations) is a node in one doubly-linked playlist.

- **One interpreter, one quantum.** `CSequence::update_internal` advances `frame_number += framerate * quantum`, fires every crossed frame's hooks via `execute_hooks`, applies physics via `apply_physics`, and when the current node hits its high frame calls `advance_to_next_animation` and continues with the *remaining* `time_left` — all in one loop, one elapsed-time quantum (`acclient.c:340659-340780`). The four-tween + clamped-vs-wall-clock split in holtburger has no retail analog.

- **One-shots and the cycle live in the SAME list; no weight blending.** The sequence is `[link/one-shot anims] … first_cyclic → [cyclic loco anims]`. `advance_to_next_animation` falls off the end of the list straight back to `first_cyclic` (`acclient.c:340563-340567`), so a swing plays *once* then the loop resumes — sequentially, not by ramping a parallel action's weight. Building a motion (`GetObjectSequence`) does `clear_physics → remove_cyclic_anims → add_motion(pre_link) → add_motion(link transitions) → add_motion(cyclic)` then `re_modify` to re-stack modifiers (`acclient.c:337736-337745`). There is **no crossfade, no 50/50 normalization** — which is exactly why retail full-body swings never play at half amplitude. The holtburger comment confirms it: "retail AC never crossfaded between motions … unconditional pointer swap with no blend state" (`entities.js:1326-1337`).

- **Gait is a framerate multiply on the cyclic nodes only.** `CSequence::multiply_cyclic_animation_fr` walks from `first_cyclic` calling `AnimSequenceNode::multiply_framerate` (`acclient.c:339736-339742`, `340968-340979`) — and a *negative* multiplier swaps low/high frame to play in reverse (`acclient.c:340972-340977`), i.e. retail's native version of `?signedMotionSpeed`. Re-requesting the same cycle with same-sign speed adjusts the running cycle in place via `change_cycle_speed`/`subtract_motion`/`combine_motion` rather than swapping actions (`acclient.c:337773-337778`) — no `.time`-preservation hack needed.

- **The speed numbers holtburger's wasm getter mirrors.** `CMotionInterp::get_state_velocity`: sidestep `1.25 × sidestep_speed`, Walk (`0x45000005`) `3.12 × forward_speed`, Run (`0x44000007`) `4.0 × forward_speed`, magnitude clamped to `run_rate × 4.0` (`acclient.c:343539-343593`); `apply_run_to_command` rewrites Walk→Run and scales by run_factor with the sidestep ±3.0 clamp (`acclient.c:343439-343482`). This is the contract `_resolveStateGroundSpeed` consumes (`entities.js:6451-6502`) — so the *inputs* are faithful; only the *application* (per-action `setEffectiveTimeScale` vs. per-node `multiply_framerate` on one list) diverges.

- **Overlay end is intrinsic, not event-driven.** Retail removes/re-adds cyclic anims structurally (`remove_cyclic_anims`, `acclient.c:340154-340227`) and `MotionDone` is hard-coded success on the renderer path; there is no `finished`-listener-vs-drain-queue race because completion is just "the interpreter advanced past the node."

## Consolidation recommendations

1. **Port `CSequence` as the single per-entity motion authority; demote the mixer to a frame sampler.** Replace `setMotion`/`setSwingMotion`/`_tryPlayLink`/the velScale tick/the four tweens with one ordered node list per entity (`[link/one-shot] … first_cyclic → [cyclic]`) advanced by one `update_internal(dt)`. This is the structural fix for *all three* reported symptoms at once (upper-body swings, no-anim missiles, independently-breaking door/death anims), because completion, blending, and gait stop being seven separately-maintained policies.

2. **Make one-shots sequential, not weighted.** Stop overlaying attack/cast on a parallel weighted action. Append them as link nodes ahead of `first_cyclic` so the cycle resumes by list advance (retail `advance_to_next_animation → first_cyclic`, `acclient.c:340563-340567`). This *deletes* `?fullBodyOneShot`, `_suppressBaseCycleForOverlay`, `_completeOverlay`, `_baseSuppressSaved`, and the listener/drain double-restore hazard (`entities.js:8330-8527`) — and the half-amplitude swing disappears by construction.

3. **Gait = one framerate multiply on cyclic nodes.** Apply `cycleTimeScale × motionSpeed × dir` once to the cyclic-node framerate (retail `multiply_cyclic_animation_fr`/`multiply_framerate`), eliminating the getter-vs-EMA double-count (`entities.js:10331-10342`) and the negative-timeScale reverse hack in favor of retail's frame-swap. Keep the wasm `stateGroundSpeed`/`cycleBaseSpeed` getters — they're already faithful — but feed them into the one interpreter, not a per-frame action mutation.

4. **Collapse the flag matrix into the authority.** `velScale`, `signedMotionSpeed`, `fullBodyOneShot`, `tweenClock`, `castSpeed`, `cycleOmega`, `gaitHz` are all symptoms of bolting behaviors onto the mixer. Once one sequence + one quantum drives everything, these become intrinsic (single clock, framerate-driven gait, sequential one-shots) rather than toggles — removing the "needs a 1070 eye-test" backlog.

5. **Retire the integrator-oscillation band-aids** (`CROSSFADE_S=0` hard-cut `.time` preservation, `_recentLocomotionTime`/`RESUME_WINDOW_MS`, `entities.js:2155-2182`, `6823-6848`) by fixing the upstream wasm integrator overshoot they exist to mask (`entities.js:2162-2175`); a continuous in-place cycle-speed change (`change_cycle_speed`, `acclient.c:337773-337778`) makes them unnecessary.

6. **Source idle variations from the MotionTable, not a random probe.** Add a wasm enumerator for a MotionTable's idle/fidget motions and let the sequence's modifier/idle stack drive them (retail authored data), replacing the guess-and-check `_idleFidgetTick` (`entities.js:10664-10671`).

*Scope note: this audit covers the locomotion/gait/cycle/overlay-interaction slice of `entities.js`. The missile-flight integration (`_ballistic`, `entities.js:10116-10129`), the hook/SetOmega timeline, and the MoveTo/dead-reckon position pipeline are adjacent systems referenced here only where they touch the loco cycle; full coverage of those belongs to the other audit assignments.*
