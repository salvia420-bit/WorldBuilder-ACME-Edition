I now have a complete picture of the hook dispatch system. Here is my audit.

## What exists

The animation-hook subsystem in `holtburger-web` is built around **one shared JS dispatch function** (`EntityManager._fireHook`, `scene3d/entities.js:11035`) — a 26-case `if (hookType === N)` typeswitch — fed by **multiple independent firing mechanisms that are all gated behind default-OFF URL flags**. The "single authority" the retail client achieves with one polymorphic queue exists here only partially, only when three separate flags are flipped on, and one of the three is inert.

Concretely, the moving parts are:

- **The dispatch core**: `_fireHook(inst, hook, audioMgr, cache)` (`entities.js:11035`) handles all 26 AnimationHook types: Sound(1), SoundTable(2), AnimDone(4), ReplaceObject(5), Ethereal(6), ramps(7–11), Scale(12), CreateParticle(13), Destroy/Stop(14/15), NoDraw(16), DefaultScript(17/18), CallPES(19), Transparent(20), SoundTweaked(21), SetOmega(22), TextureVelocity(23/24), SetLight(25), CreateBlockingParticle(26).
- **Three URL flags** that decide whether dispatch is unified: `SCRIPT_QUEUE_ON` (`entities.js:834`, `?scriptQueue`), `HOOK_DRAIN_ON` (`entities.js:862`, `?hookDrain`), `MT_QUEUE_ON` (`entities.js:894`, `?mtQueue`) — **all default OFF** (they read `!== "off"` but the surrounding `try` returns `false` when there's no `window`, and the documented default in the comments is OFF).
- **The timeline executor**: `_tickAnimationHooks(inst)` (`entities.js:10894`) → `_fireHooksInRange` (`entities.js:11007`) → `_fireHook`.
- **The drain queue**: `inst._hookFireQueue` (`entities.js:2050`, `2063`) + the pure planner `scene3d/hook_windows.js` + the end-of-tick drain (`entities.js:10498`).
- **The PhysicsScript path**: legacy `setTimeout` walker in `_attachParticleChainForEntity` (`entities.js:8762`) **or** `ScriptManager` (`scene3d/script_manager.js`) + `_decodePhysicsScriptHookEntry` (`entities.js:9278`) + `_executeScriptHook` (`entities.js:9439`).
- **AnimationDone / completion**: `_completeOverlay` (`entities.js:8508`), `notifyMtQueuedOverlayDone` (`entities.js:953`), the wasm bridge `window.__notifyAnimationDone` (`index.html:8277`), and `_mtQueuedKeys` tagging (`entities.js:2063`).

## How it works (file:line)

**1. Baking.** Hooks are snapshotted out of wasm per animation clip in `scene3d/animation.js:701-774` (`animData.takeHooks()` → plain-object array with `time`, `hookType`, `direction`, and all per-type payload fields), keyed into `inst.hookTimelines` (`entities.js:8219`). `inst.actionLastHookTime` tracks the last fired clip-time per action (`entities.js:8221`).

**2. Firing (timeline path).** Each frame the per-instance tick calls `_tickAnimationHooks(inst)` (`entities.js:10369`). It **walks every running mixer action** — locomotion cycle *and* one-shot overlays (`entities.js:10909`) — reads `action.time`, and fires hooks in the crossed window via `_fireHooksInRange` (`entities.js:10985`). The range walker (`entities.js:11011-11026`) either calls `_fireHook` **inline** (default) or, under `?hookDrain=on`, **pushes `{kind:"hook"}` records onto `inst._hookFireQueue`** (`entities.js:11022`).

**3. Drain.** Under `?hookDrain=on` the queue is drained at the **end of the tick body, after all pose/tween/material application** (`entities.js:10498-10519`), executing `{kind:"hook"}` via `_fireHook` and `{kind:"animDone"}` via `_completeOverlay`. The finish-drain math (a LoopOnce that crossed its end between two rAFs must still fire trailing hooks once, then queue its `animDone`) lives in the pure planner `planHookWindows` (`hook_windows.js:37-76`), invoked at `entities.js:10943`.

**4. Dispatch.** `_fireHook` (`entities.js:11035`) first applies the direction gate (`hook.direction === -1 → return`, `entities.js:11069`), then runs the long `if (hookType === …)` chain. AnimDone is a special case: `hookType === 4` (`entities.js:11386-11402`) **only emits a plugin diag event and bumps a counter — it is NOT the lifecycle completion.**

**5. PhysicsScript path.** `_attachParticleChainForEntity` (`entities.js:8762`) is the chain walker. Under `?scriptQueue=on` it delegates to `_queuePhysicsScript` (`entities.js:8806-8807`), which decodes each entry with `_decodePhysicsScriptHookEntry` (`entities.js:9278`, the documented "SEAM" at `9271-9273`) and fires through the **same** `_fireHook` via `_executeScriptHook` (`entities.js:9439`). The `ScriptManager` (`script_manager.js:66`) is a time-ordered queue with an injected executor (`script_manager.js:96`, `224`) — it deliberately contains **no dispatch switch of its own** (`script_manager.js:11-18`). With the flag OFF, the legacy `setTimeout`-per-hook walker runs instead (`entities.js:8824-9080`), and it handles **only a subset** of hook types with its own inline arms (Sound at `8829`, CreateParticle at `9025`, etc.).

**6. Completion / AnimationDone.** Three disjoint detectors:
- `_completeOverlay` (`entities.js:8508`) — the intended single owner — restores the suppressed base-cycle weight and calls `notifyMtQueuedOverlayDone`. Reached only via the drain `animDone` record (`entities.js:10508`).
- A mixer `"finished"` listener registered in `_suppressBaseCycleForOverlay` (`entities.js:8362-8374`) — used **only when `?hookDrain` is OFF** (the two are mutually exclusive to avoid double-restore, `entities.js:8352-8356`).
- A second `"finished"` listener `onMtFinished` (`entities.js:8242-8248`) installed when `?mtQueue=on && !hookDrain`.

**7. notifyAnimationDone (wasm boundary).** `notifyMtQueuedOverlayDone` (`entities.js:953`) gates on `MT_QUEUE_ON`, then on **tagged keys only** (`_mtQueuedKeys.has(key)`, `entities.js:956`), then calls `window.__notifyAnimationDone` (`index.html:8277`) → `handle.notifyAnimationDone` (wasm) → `MotionTableManager`. **Critically, no caller currently tags plays** (`entities.js:888-890`, `8222-8228`: "NO current caller passes `mtQueued: true`"), so this entire cross-boundary completion path is **inert today**.

## Fragility & workarounds

1. **The default runtime is the fragmented one.** `scriptQueue`, `hookDrain`, `mtQueue` all default OFF (`entities.js:834,862,894`). So out of the box: timeline hooks fire **inline** (before position resolve), PhysicsScript hooks fire on **wall-clock `setTimeout`** through a *different, subset-only* dispatch (`entities.js:8824-9080`), and completion is detected by ad-hoc mixer listeners. Unification is opt-in, not the shipped behavior.

2. **Two parallel dispatch implementations.** `_fireHook` (full 26-type) and the legacy `setTimeout` walker (subset). The comments admit the walker leaves a "G14 visual-hook routing gap (16/20/23/24/25 now reach `_fireHook`)" that is closed **only** under `?scriptQueue=on` (`entities.js:831-832`). So SetLight/Transparent/TextureVelocity from PhysicsScripts silently no-op on the default path.

3. **Full parity needs all three flags AND a missing consumer.** The flags are "independently flippable" (`entities.js:891`) but "full retail ORDERING parity needs both on" (`entities.js:892`), and even with all on, `notifyAnimationDone` stays inert until "the A3-D2 / ?interpRig enqueue-consumers land and tag remote one-shots" (`entities.js:951-952`). This is a multi-stage migration frozen mid-flight.

4. **AnimationDone is scattered across 4+ mechanisms.** The `hookType===4` arm is diag-only (`entities.js:11386`); real completion is split between `_completeOverlay` (drain path), two distinct mixer `"finished"` listeners (`entities.js:8242`, `8362`), and the inert wasm notify. The code must carefully keep these mutually exclusive to avoid double weight-restore (`entities.js:8352-8356`, "spec S5 §5 risk 5").

5. **Ordering hazard fixed only under a flag.** Inline firing (default) runs hooks *before* the frame's pose/position/tween resolve; retail runs `process_hooks` *after* (`acclient.c:320035`). Only `?hookDrain=on` reproduces the correct order (`entities.js:10489-10497`).

6. **Direction-gate divergence requiring a workaround.** PhysicsScript hooks must be force-set to `direction = 0` in `_decodePhysicsScriptHookEntry` (`entities.js:9300-9301`) because feeding raw on-disk direction "re-created the exact on/off-path divergence the `?scriptQueue` flag's 'byte-identical' contract forbids" (`entities.js:9298-9299`).

7. **Swing/cast/jump are not hooks at all.** They are separate pose-tween systems (`_swingTween` `entities.js:10400`, `_castTween` `10418`, `_jumpPoseTween` `10384`) layered post-mixer, plus `_suppressBaseCycleForOverlay` ramping the base cycle to 0 (`entities.js:8299`, `8338`). This is the structural root of "attacks only swing the upper body" — the strike is a partial-body tween, not a sequence whose AnimDone/strike-frame hooks drive the body uniformly.

## Retail (acclient) comparison

Retail has exactly the single authority this client is reaching for:

- **ONE queue.** `CSequence::execute_hooks(animframe, dir)` (`acclient.c:339683`) walks the current AnimFrame's hooks, applies the direction gate (`if (!v5 || dir == v5)`, `acclient.c:339695` — the same `direction==0||direction==dir` rule), and appends each to the object's `anim_hooks` SmartArray via `CPhysicsObj::add_anim_hook` (`acclient.c:322063`). The AnimDone hook is appended to the **same** array after the frame's trailing hooks at segment exhaustion (`acclient.c:340773`).

- **ONE drain.** `CPhysicsObj::process_hooks` (`acclient.c:318641`) walks the FP-hook linked list calling `v2->vfptr->Execute(v2, v1)` (`acclient.c:318658`), then walks `anim_hooks.m_data[]` calling `m_data[i]->vfptr->Execute(v1)` (`acclient.c:318684`), then clears the array (`m_num = 0`, `acclient.c:318688`). It is invoked **after** position resolve (`acclient.c:320035`).

- **VIRTUAL dispatch, not a typeswitch.** Each hook type is its own polymorphic class with its own `Execute`: `SoundHook::Execute` (`acclient.c:342188`), `SoundTableHook::Execute`, `SetLightHook::Execute`, `CallPESHook::Execute`, `ScaleHook::Execute`, `CreateParticleHook::Execute`, `AnimDoneHook::Execute`, etc. (declared `acclient.c:7018-7060`). The *type is the object*; there is no central switch to fall out of sync.

- **AnimationDone is just another hook.** `AnimDoneHook::Execute` (`acclient.c:342336`) → `CPhysicsObj::Hook_AnimDone` (`acclient.c:317087`) → `CPartArray::AnimationDone(v1, 1)` (`acclient.c:317093`/`325080`) → `MotionTableManager::AnimationDone` (`acclient.c:329873`). Same queue, same drain, success hard-coded `1` on the renderer path.

- **Uniform across every object.** All of this is on `CPhysicsObj` — players, monsters, doors, missiles, particle emitters share one `anim_hooks` queue, one `process_hooks` drain, one `CMotionInterp/CSequence` feeder. There is no per-entity-type fork and no flag.

The holtburger `_fireHook` *is* a genuine shared method called for any `inst` regardless of type — that part is unified. What is **not** unified is everything around it: the firing mechanism (inline vs. drain queue vs. `setTimeout` walker vs. `ScriptManager`), the completion detection (4 mechanisms), and the fact that the unified configuration is gated behind three default-off flags plus a never-wired tagging consumer.

## Consolidation recommendations

1. **Make `?hookDrain` + `?scriptQueue` the only path; delete the flags and the legacy walker.** Remove the `setTimeout` walker (`entities.js:8824-9080`) outright and route all PhysicsScript hooks through `_queuePhysicsScript` → `_fireHook`. This eliminates the second (subset-only) dispatch implementation and closes the G14 SetLight/Transparent/TextureVelocity gap permanently.

2. **Collapse firing onto the single queue+drain.** Always queue into `inst._hookFireQueue` and drain after position/pose resolve (`entities.js:10498`). This makes the JS order match retail's `process_hooks`-after-`UpdatePositionInternal` (`acclient.c:320035`) unconditionally and removes the inline-vs-deferred ordering split.

3. **Make AnimationDone one owner.** Route *all* completion through the queued `{kind:"animDone"}` → `_completeOverlay` record and delete the two ad-hoc mixer `"finished"` listeners (`entities.js:8242`, `8362`). The `hookType===4` arm (`entities.js:11386`) should feed the same completion path, not just a diag event — mirroring retail where AnimDone is one more hook in the same array.

4. **Finish the `notifyAnimationDone` wiring.** Tag the one-shot plays that need cross-boundary completion (the missing `mtQueued: true` callers, `entities.js:8229`) so the wasm `MotionTableManager::AnimationDone` is actually driven. Until that lands, monster-death/door/missile completion that depends on the wasm motion interpreter cannot be uniform — this is the direct analog of why those break "independently."

5. **Fold swing/cast/jump into the sequence/hook model.** The pose-tween systems (`_swingTween`/`_castTween`/`_jumpPoseTween`, `entities.js:10384-10431`) and base-cycle suppression (`entities.js:8338`) are the real source of "upper-body-only attacks / missiles with no animation." They should become full-body LoopOnce sequences whose strike-frame and AnimDone hooks flow through the same `_fireHook`+drain, exactly as retail plays a single `CMotionInterp` motion for the whole body.

6. **Optional: convert the `_fireHook` typeswitch to a per-type handler table.** A `Map<hookType, fn>` (retail's vtable analog) would make the dispatch extensible without editing one 600-line function, but this is a maintainability nicety — the typeswitch is already a single authority and is the lower-priority item versus 1–5.

The bottom line for your hypothesis: dispatch **is** funneled to one `_fireHook` executor, but firing and completion are **not** unified — they run through a default-fragmented set of inline/setTimeout/listener paths, with the retail-shaped queue→drain→polymorphic-completion design present but gated behind three default-off flags and one unfinished consumer.
