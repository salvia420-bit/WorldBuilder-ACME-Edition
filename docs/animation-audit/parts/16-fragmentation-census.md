I now have a complete, concrete picture. Writing the census report.

---

# Animation/Motion Census — holtburger web client (`external/holtburger/apps/holtburger-web`)

**Scope:** every runtime entry point that plays a clip, sets a motion, drives an `AnimationMixer`, or tweens a transform. Read directly from source; every row cites `file:line`. Audio `.play()` is excluded (sound, not motion). Test/capture harnesses (`capture_*.cjs`, `test_*.mjs`, `probe_*`) are excluded from the runtime table — they are Puppeteer drivers, not client motion.

## What exists

There is **no single motion authority**. Motion is produced by **at least seven independent subsystems**, three of which run *concurrently per entity in the same `tick(dt)` loop* and reconcile each other with ordering hacks:

1. **three.js `AnimationMixer`** (skeletal clip crossfade/weight-blend) — the closest thing to a spine, reached via `EntityManager.setMotion` / `_tryPlayLink` / `setSwingMotion`.
2. **Hand-rolled per-entity pose tweens** — jump / swing / cast quaternion tweens, slerped *after* `mixer.update` so they "win".
3. **A second, parallel animation engine** — the PhysicsScript "hook" system: `_tickAnimationHooks` + `_tickHookOmega` (spin) + `_tickMaterialHooks` (texture velocity) + `_tickScaleHookTween` + a per-guid `ScriptManager`.
4. **Dead-reckon / heading / ballistic / sticky** transform easing (more hand-rolled lerps/slerps in the same loop).
5. **Door rotation** — a bespoke `evt.kind===15` handler in `index.html` that *instantly snaps* `sprite.rotation` (no tween, no mixer, no motion table).
6. **Standalone rAF tween loops** — `play_effect_vfx`, `spell_shape_preview`, `speech_bubble`, `combat-bar`, particle manager.
7. **Static-pose preview rigs** (`ac_dye_viewport`, `ac_paperdoll_viewport`) and the **legacy 2D PIXI** heading path in `index.html`.

Retail (`acclient.c`) instead routes **every animated object** — players, monsters, doors, missiles, static animating props — through **one** pipeline: `CPhysics::UseTime` → `CPhysicsObj::update_object` → `CMotionInterp::DoMotion` → `CMotionTable::DoObjectMotion`/`get_link` (sequence interpreter) → keyframe anim + `process_hooks`, all on one clock.

## How it works (file:line)

### The central dispatcher (the only semi-shared path)
- `EntityManager.setMotion(guid, cmd, stance, speed)` — `scene3d/entities.js:6522`. Applies wire-command substitution hacks (Stop→Ready `:6549`, Left→Right `:6567`), then `classifyMotionCommand(cmd)` `:6602` routes to **three different mechanisms**:
  - `"stop"`/`null` → `fadeOutCurrent(CROSSFADE_S)` `:6604` (mixer fade-out).
  - `"attack"`/`"cast"` → `_tryPlayLink` LoopOnce **overlay** `:6638`, and **manually clears** the in-flight `_swingTween`/`_castTween` `:6643`,`:6647`.
  - locomotion → `crossFadeTo(...)` cycle swap (`:2139`).
- `crossFadeTo(nextAction, key, durS)` — `scene3d/entities.js:2139` → `currentAction.crossFadeTo(...)` `:2196` (three.js weight blend), hard-swap fallback `:2198`.
- `fadeOutCurrent(durS)` — `scene3d/entities.js:2223`.
- `_tryPlayLink(inst, setupId, mtableId, fromCmd, toCmd, stance, opts)` — `scene3d/entities.js:8145`; `mixer.clipAction(clip)` `:8199`, `action.play()` `:8262`. Used for swings, casts, gestures, jump (`0x2500003B`, see `:1061`).
- `setSwingMotion(guid, cmd, opts)` — `scene3d/entities.js:6014` (a **second** clip-play entry: `clipAction` `:6080`, `.play()` `:6108`).
- Spawn initial action — `scene3d/entities.js:3280` (`new THREE.AnimationMixer(root)`), `clipAction` `:3299`, `.play()` `:3326`.
- Per-frame mixer advance — `scene3d/entities.js:10355` `inst.mixer.update(dt)`.
- Velocity-scaled gait (anti-ice-skating) — modifies mixer `effectiveTimeScale` from an EMA of XZ position delta, `scene3d/entities.js:10252`–`10288`.

### Dispatch surface that *feeds* setMotion
- `camera.js` movement→motion bridge: `em.setMotion(g, cmd, stance)` — `scene3d/camera.js:1852`.
- `loop.js` server-reconciliation: `em.setMotion(...)` at `scene3d/loop.js:354`, `:405`, `:2152`, `:2212`, `:2522`, `:2586`.
- `index.html` keystate + jump + click-to-attack: `em.setMotion(...)` at `index.html:8923`, `:9266`, `:11822`; `handle.setMovementInput(...)` `:11777`.

### Parallel per-entity engines, all dispatched inside one `tick(dt)` (`scene3d/entities.js:9947`)
The per-entity body fires these **in sequence, every frame**:
| dispatch line | driver | defined at |
|---|---|---|
| `:10355` | `mixer.update(dt)` (skeletal) | three.js |
| `:10369` | `_tickAnimationHooks(inst)` | `:10894` |
| `:10386` | `_tickJumpPoseTween` | `:6231` (+ apply `:5470`/`:5532`) |
| `:10402` | `_tickSwingTween` | `:6332` (pose set `:5603`) |
| `:10420` | `_tickCastTween` | `:6359` (pose set `:5650`) |
| `:10438` | `_tickScaleHookTween` | `:11650` |
| `:10455` | `_tickHookOmega` (spin) | `:12151` |
| `:10477` | `_tickMaterialHooks` (texture velocity) | `:12107` |
| `:10623` | `scriptManager.update(now)` per guid | `scene3d/script_manager.js:208` |

Also in the same loop, hand-rolled transform integration: ballistic projectile `:10116`, sticky-melee glue `:10153`, dead-reckon position ease `:10179`, heading slerp ease `:10220`.

### The PhysicsScript "hook" engine (second animation system)
- `_tickAnimationHooks` — `scene3d/entities.js:10894`; consumes `PhysicsScript` hooks fetched via `fetchPhysicsScriptTable` (`import` at `:814`), prewarmed at spawn `:3655`–`3670`.
- `ScriptManager` — `scene3d/script_manager.js:66`, `update(now)` `:208` (time-ordered hook firing, "no setTimeout").
- `ac_physics_script_table.js` / `ac_play_script.js` — table fetch + recursive sub-script invocation (type 19, see `entities.js:803`).

### Doors (fully independent, *not animated* — snapped)
- `DoorStateChanged` handler `evt.kind===15` — `index.html:10647`. Computes `rotation = open ? Math.PI/2 : 0` `:10669` and **instantly assigns** `entry.sprite.rotation = rotation` `:10702` and the building static part `matchedPart.sprite.rotation = rotation` `:10767`. Comment `:10696`: "Hinge-frame extraction from SetupModel is **deferred** … for now we approximate by rotating around the sprite centre."
- Door rotation state field — `scene3d/buildings.js:420` `doorRotationRad: 0`; per-part hinge wrapper Group `:400`–`415`.
- `Door` model class is data-only (`use()`/`isOpen`) — `plugins/world-objects/door.js:16`–`34`.

### Standalone rAF loops (each its own clock)
- VFX bursts — `scene3d/play_effect_vfx.js`: own `_tickAllBursts()` `:640` + `requestAnimationFrame` `:674`; scale `:660`, rotation `:671`, opacity ease.
- Spell-shape preview — `scene3d/spell_shape_preview.js`: per-overlay `tween(t)` `:130`, `_ensureRafRunning` `:637`, ease-out/opacity factories `:249`,`:256`.
- Speech bubbles — `scene3d/speech_bubble.js`: own rAF fade `:203`–`224` (`material.opacity = 1 - f`).
- Particles — `scene3d/particles/particle_manager.js` `tick()` (`:66`), per-particle scale/opacity lerp `scene3d/particles/particle.js:424`.
- Combat bar — `plugins/combat-bar.js:1049` (tween handle).

### Camera (own predictive lerp/slerp)
- `camera.js`: `persp.position.lerp(...)` `:1123`, `persp.quaternion.slerp(...)` `:1130`; in-flight reconcile lerp `_applyPredictionLerp` `:1460`, target setup `:1256`.

### Static-pose preview rigs (build a rig, no mixer)
- `ui/ac_dye_viewport.js:198` — "rig-build loop but **without restPose, mixer**, scene parenting"; sets part quaternions from `restOrigins` `:214`,`:333`.
- `ui/ac_paperdoll_viewport.js` — same static-pose pattern.

### Legacy 2D PIXI heading path (index.html)
- `entry.sprite.rotation = -quaternionToYaw(...)` — `index.html:3999`, `:5837`, `:6620`, `:11648` (heading written directly to sprite, fights the 3D path).

## Census table — every distinct motion entry point (classified)

"Unified" = routed through the one shared entity path (mixer dispatcher). "Bespoke" = its own ad-hoc mechanism/clock. Note the mixer path is *only* "unified" relative to this client; vs retail it is itself bespoke (see comparison).

| # | Entry point | File:line | Mechanism | Class |
|---|---|---|---|---|
| 1 | `setMotion` central router | `scene3d/entities.js:6522` | classify→3-way | **Semi-unified spine** |
| 2 | `crossFadeTo` (locomotion) | `scene3d/entities.js:2139` | mixer crossFade | Unified (mixer) |
| 3 | `fadeOutCurrent` (stop) | `scene3d/entities.js:2223` | mixer fadeOut | Unified (mixer) |
| 4 | `_tryPlayLink` overlay (attack/cast/gesture/jump) | `scene3d/entities.js:8145`,`8262` | mixer LoopOnce | Unified (mixer) |
| 5 | `setSwingMotion` (2nd clip entry) | `scene3d/entities.js:6014`,`6108` | mixer clipAction | Unified (mixer) |
| 6 | spawn initial action | `scene3d/entities.js:3299`,`3326` | mixer clipAction | Unified (mixer) |
| 7 | `mixer.update(dt)` | `scene3d/entities.js:10355` | mixer tick | Unified (mixer) |
| 8 | velocity-scaled gait timescale | `scene3d/entities.js:10252`–`10288` | mixer timeScale hack | Bespoke (on mixer) |
| 9 | `setSwingPose`/`_tickSwingTween` | `scene3d/entities.js:5603`/`6332`→`10402` | triangle-wave quat tween | **Bespoke** |
| 10 | `setCastPose`/`_tickCastTween` | `scene3d/entities.js:5650`/`6359`→`10420` | quat tween | **Bespoke** |
| 11 | jump pose tween | `scene3d/entities.js:5470`,`5532`,`6231`→`10386` | quat tween + mixer-time pause | **Bespoke** |
| 12 | `releaseSwingHold` (mixer-time pause/peak hold) | `scene3d/entities.js:5953` | mixer time freeze | **Bespoke** |
| 13 | `setPose`/`applyManagedPose` | `scene3d/entities.js:2111`,`4016`,`4041` | direct transform write | **Bespoke** |
| 14 | dead-reckon position ease | `scene3d/entities.js:10179`–`10204` | exp lerp | **Bespoke** |
| 15 | heading slerp ease | `scene3d/entities.js:10220`–`10245` | exp slerp | **Bespoke** |
| 16 | ballistic projectile integration | `scene3d/entities.js:10116`–`10128` | Euler integrate | **Bespoke** |
| 17 | sticky-melee glue | `scene3d/entities.js:10153`–`10172` | exp lerp | **Bespoke** |
| 18 | `_tickAnimationHooks` (PhysicsScript) | `scene3d/entities.js:10894`→`10369` | hook engine | **Bespoke (2nd engine)** |
| 19 | `_tickHookOmega` (spin) | `scene3d/entities.js:12151`→`10455` | omega integrate | **Bespoke (2nd engine)** |
| 20 | `_tickMaterialHooks` (texture velocity) | `scene3d/entities.js:12107`→`10477` | uv scroll | **Bespoke (2nd engine)** |
| 21 | `_tickScaleHookTween` | `scene3d/entities.js:11650`→`10438` | scale tween | **Bespoke (2nd engine)** |
| 22 | `ScriptManager.update` (per-guid) | `scene3d/script_manager.js:208`→`entities.js:10623` | time-ordered hooks | **Bespoke (2nd engine)** |
| 23 | PhysicsScriptTable fetch/exec | `ui/ac_physics_script_table.js`, `ui/ac_play_script.js` | script table | **Bespoke (2nd engine)** |
| 24 | Door open/close snap | `index.html:10669`,`10702`,`10767` | instant `sprite.rotation` | **Bespoke (no anim)** |
| 25 | Door hinge-wrapper state | `scene3d/buildings.js:400`,`420` | static Group rotation | **Bespoke** |
| 26 | VFX burst tween loop | `scene3d/play_effect_vfx.js:640`,`674` | own rAF scale/opacity/rot | **Bespoke (own rAF)** |
| 27 | Spell-shape preview tween | `scene3d/spell_shape_preview.js:130`,`637` | own rAF | **Bespoke (own rAF)** |
| 28 | Speech-bubble fade | `scene3d/speech_bubble.js:203`–`224` | own rAF opacity | **Bespoke (own rAF)** |
| 29 | Particle sim | `scene3d/particles/particle_manager.js:66`; `particle.js:424` | own tick + per-particle lerp | **Bespoke** |
| 30 | Combat-bar tween | `plugins/combat-bar.js:1049` | UI tween | **Bespoke** |
| 31 | Camera predictive lerp/slerp | `scene3d/camera.js:1123`,`1130`,`1460` | own lerp/slerp | **Bespoke** |
| 32 | Dye preview rig (static pose) | `ui/ac_dye_viewport.js:198`,`214` | rest-pose, no mixer | **Bespoke (static)** |
| 33 | Paperdoll viewport rig | `ui/ac_paperdoll_viewport.js` | rest-pose, no mixer | **Bespoke (static)** |
| 34 | Legacy 2D heading writes | `index.html:3999`,`5837`,`6620`,`11648` | direct `sprite.rotation` | **Bespoke (2D path)** |

**Tally:** 7 entries ride the mixer spine (rows 1–7); **27 are bespoke**. Of those, 16 live *inside `entities.js`* alone, and **3 separate engines** (mixer / pose-tweens / PhysicsScript-hooks) animate the same entity concurrently. Doors and missiles are animated by neither a clip nor a tween (snap / Euler integrate).

## Fragility & workarounds

Concrete evidence of the piecemeal design, quoted from the code:

- **Three engines fight over the same rig; order = correctness.** Pose tweens are slerped *after* `mixer.update` specifically so they "win" — `entities.js:6226` "Called from `tick` after `mixer.update` so our slerp wins"; `:11647` scale tween "after `mixer.update` so the scale wins". When a real clip must take over, the tween is **manually nulled**: `setMotion` clears `inst._swingTween = null` (`:6643`) and `inst._castTween = null` (`:6647`) with the comment "It applies in `_tickSwingTween` AFTER `mixer.update`, so it would otherwise overwrite the real motion-table clip's arm pose." This is exactly the "attacks only swing the upper body" failure mode — a placeholder triangle-wave tween (`setSwingPose`) is the swing, layered over locomotion.
- **Missiles fire with no animation.** Projectiles have no clip and no motion-table dispatch; they are hand-integrated as constant-velocity (`entities.js:10116`) because "ACE never broadcasts an in-flight UpdatePosition" — there is no missile motion path at all, only position integration.
- **Doors break independently.** Door open is a one-off `index.html:10647` event handler that **snaps** `sprite.rotation = π/2` (`:10669`,`:10702`) with hinge extraction explicitly "deferred" (`:10696`). It touches the 2D sprite *and* a separately-resolved building static part (`:10767`) via a fallback spatial scan (`findClosestBuildingPart`) — two code paths that can desync, with no tween and no relation to the entity mixer.
- **Clock desync.** The header at `entities.js:545`–`553` documents that mixer + `_tickHookOmega` + `_tickMaterialHooks` + tweens can "tween family 2s of wall time while the mixer advances ~16ms, desyncing pose" — patched with a separate `_tweenClockMs` (`:9955`) seeded to advance in lockstep. Each standalone rAF loop (VFX, spell preview, speech bubble) has *its own* clock, none synced to the mixer.
- **Two parallel hook systems.** Hooks run both inline (`_tickAnimationHooks` `:10369`) **and** via a separate per-guid `ScriptManager` (`:10623`) — header at `:856` calls them "our analog of process_hooks" but split across two dispatchers.
- **Mixer action accretion.** Re-firing motion "would accrete unbounded mixer actions; the cap evicts" (`:1322`, `uncacheAction` `:2281`) — a manual LRU because the mixer has no sequence lifecycle.
- **Heading written from 3 places** (mixer/slerp ease at `:10240`, server snap in `setPose`, and the legacy 2D `sprite.rotation` at `index.html:5837`) which "fights the JS-side step-3.5" snap (`index.html:6605`).

The reason each break "needs weeks of rework": every motion type has its own producer, its own clock, and its own reconciliation rule against the other producers. There is no shared place to fix a class of motion.

## Retail (acclient) comparison

Retail has **one** motion authority and one per-frame clock for **every** animated object:

- **One update loop over all physics objects** — `CPhysics::UseTime` iterates the object hash and calls `CPhysicsObj::update_object(curPtr_)` for every object (`acclient.c:311372`–`311379`), then `animate_static_object` for static animators (`:311384`) and `CPhysics::UpdateTexVelocity(quantum)` (`:311388`) — texture velocity is part of the *same* pass and clock, not a separate `_tickMaterialHooks`.
- **One motion entry point** — `CMotionInterp::DoMotion(this, motion, params)` (`acclient.c:344600`) is the single call for *all* motion commands; it feeds `DoInterpretedMotion` (`:344659`) and an `InterpretedMotionState` action queue (cap 6, `:344653`). Movement, attacks, gestures all go through it (`PerformMovement` switch, `:344683`).
- **One sequence interpreter** — `CMotionTable::DoObjectMotion(motion, curr_state, sequence, speed, &num_anims)` (`:330225`, def region `:337641`) resolves a motion into a **`CSequence` of keyframe animations** via the link table `CMotionTable::get_link(style, substate, …, motion, speed)` (`:337585`,`:337708`). The full table API — `GetObjectSequence`, `get_link`, `StopObjectMotion`, `StopObjectCompletely`, `StopSequenceMotion`, `SetDefaultState`, `is_allowed` — is one cohesive sequencer. This is the **CMotionTable/CMotionInterp** spine the hypothesis names.
- **Hooks are subordinate to the sequence, not a parallel engine** — `CPhysicsObj::process_hooks` (`:318641`) runs hooks that were emitted *by* the running animation (`add_anim_hook` from the sequence, `:339696`,`:340773`). So omega/scale/texture/sound hooks ride the same frame and clock as the keyframe animation; they cannot desync from it.

Net contrast: retail = `motion → DoMotion → DoObjectMotion/get_link → CSequence (+ subordinate hooks) → one UseTime clock`, uniformly for players, monsters, **doors**, missiles, and static props. holtburger = `setMotion → classify → {mixer crossfade | mixer overlay | null}` for skeletal humanoids **only**, while doors/missiles/VFX/scripts/hooks each get a separate bespoke producer on a separate clock, reconciled by execution-order hacks.

## Consolidation recommendations

1. **Introduce one `MotionInterp` per entity as the sole motion authority**, mirroring `CMotionInterp`. Every producer (locomotion, attack, cast, jump, gesture, door, missile, omega/scale/texture hooks) submits a *motion command*; the interpreter resolves it to a sequence. Replace the 3-way `classifyMotionCommand` fork in `setMotion` (`entities.js:6602`) with a single `doMotion(cmd, params)` enqueue.
2. **Port `CMotionTable` as a sequence interpreter, not a crossfade blend.** Use `get_link`/`GetObjectSequence` semantics (`acclient.c:337585`,`:337641`) so swings/casts are real keyframe sequences over the whole body — this directly fixes "attacks only swing the upper body" and "missiles fire with no animation" (give missiles a launch/flight motion through the same table). The three.js `AnimationMixer` can remain the *backend* that plays the resolved keyframes, but it must be driven by the interpreter, not addressed directly from 8 call sites.
3. **Collapse the parallel hook engine into the sequence.** Fold `_tickAnimationHooks`, `_tickHookOmega`, `_tickMaterialHooks`, `_tickScaleHookTween`, and `ScriptManager` (`entities.js:10369`–`10623`) into hooks *emitted by the active sequence and processed once per frame*, matching `process_hooks` (`acclient.c:318641`). Delete the per-guid `ScriptManager` as a separate dispatcher.
4. **Delete the bespoke pose tweens** (`setSwingPose`/`setCastPose`/jump pose, `entities.js:5603`/`5650`/`5470`) — they exist only because the real motion-table clips aren't resolving. Once #2 lands they are redundant, and so is the manual `_swingTween = null` reconciliation (`:6643`).
5. **Route doors through the same interpreter.** A door's open/close is a motion command in retail; replace the instant `sprite.rotation = π/2` snap (`index.html:10669`–`10767`) and the `doorRotationRad` static field (`buildings.js:420`) with a hinge motion sequence so doors animate (and break/fix) with everything else. This requires the deferred hinge-frame extraction from SetupModel (`index.html:10696`).
6. **Unify the clock.** One per-frame `UseTime(dt)` quantum advances mixer + hooks + tweens, as retail does in one loop (`acclient.c:311372`–`311388`). Retire the standalone rAF loops in `play_effect_vfx.js:674`, `spell_shape_preview.js:637`, `speech_bubble.js:203` onto that shared clock (`_tweenClockMs`, `entities.js:9955`) so VFX/overlays cannot desync from animation.
7. **Leave genuinely separate concerns separate** but document them: camera predictive lerp (`camera.js:1460`), particle simulation (`particle_manager.js`), static preview rigs (`ac_dye_viewport.js:198`), and the legacy 2D PIXI heading path (`index.html:5837`) are not part of the object-motion authority — but the 2D `sprite.rotation` writes should be retired with the 2D renderer to stop them fighting the 3D heading ease (`entities.js:10240`).

**Bottom line:** 34 distinct motion entry points, 27 bespoke, 3 concurrent engines on 1 rig, doors/missiles animated by neither clip nor tween — against retail's single `CMotionInterp`/`CMotionTable` sequence pipeline on one clock. The fragmentation is the defect; a ported sequence interpreter is the fix.
