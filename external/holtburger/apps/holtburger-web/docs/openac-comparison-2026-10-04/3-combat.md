# 3 — Combat / casting / missile: holtburger-web vs OpenAC vs retail (read-only study, 2026-10-04)

Abbreviations: HB = `external/holtburger/apps/holtburger-web` (unless a crate path is given) ·
OA = `external/OpenAC/src` · AC = `~/ac-headers/acclient.c` · ACE = `external/ACE/Source/ACE.Server`.
I opened every file:line below myself. OpenAC is a reference implementation, not ground truth. Each item is anchored to the decomp or to ACE.
I left out items PARITY-LEDGER already marks resolved (C1/K5 silent cast, G1/DEC-10 halved windup, DEC-13 speed, DEC-16 CMT collapse, E10/DEC-14 durations) unless the comparison shows the fix is incomplete.

---

## P0 — likely regressions or root causes behind the open ledger items

### P0-1. DEC-17 queue + `setMotion` free = a "zombie head" that wedges every later swing/cast gesture (HIGH confidence by reading; not yet checked in the browser)
* **Mechanism.** `setMotion` frees the in-flight one-shot unconditionally and nulls the playhead, but does not remove it from `_unifiedQueue`:
  HB `scene3d/entities.js:10090-10093`:
  `if (inst._unifiedSeq) { try { inst._unifiedSeq.seq.free(); } catch {} inst._unifiedSeq = null; }`
  This runs before the attack/cast routing at `:10380-10414`, so it fires for every command, locomotion or gesture.
  `_clearUnifiedQueue` is called only for door/missile direct one-shots (`:9268`), death (`:10327`) and despawn (`:3558`). The locomotion path does not call it, although the DEC-17 ledger text says it does.
  The next `_enqueueUnifiedOneShot` (`:9289`) appends behind the stale head. `_promoteUnifiedHead` (`:9306-9316`) then promotes `list[0].payload`, which is the freed record. Its `payload` is non-null, so the "skip empty payload" loop doesn't catch it.
  The tick (`:15096-15117`) calls `ua.seq.advance()` on a wasm object whose `__wbg_ptr` is 0. wasm-bindgen's `free()` zeroes it (`pkg/holtburger_web.js:5653-5667`), so the call throws. The catch (`:15130-15137`) only warns once, so the `done` branch never runs and `_unifiedOneShotFinished` never retires the zombie.
  From then on, every new gesture for that entity queues behind a head that can never finish. The cap at `:9296` only ever splices index 1, never the head. The rig is also frozen until the next `setMotion` nulls the playhead again.
* **Triggers in normal play.**
  (a) A windup gesture N+1 arrives while N is still playing. Our baked clip is about one frame per segment longer than ACE's GAL pacing (the WS11 note at `:8925-8932` says so).
  (b) A fizzle, reject or anim-break calls `cancelCastSequence`, which calls `setMotion(Ready)` (`:9136-9141`; callers at `index.html:9680`, `:9719`, `:10011`, `:11114`).
  (c) Any locomotion update during a melee swing or a bow reload.
  This matches the foundation symptoms "arms aren't always rising" and "movement breaks animations", and it would apply to melee too. DEC-17 says "Browser eye-test NOT done". The I2 measurements that saw each gesture start exactly once predate DEC-17.
* **OpenAC / retail.** There is no separate free. Every motion goes through one `CSequence` plus one `pending_animations` list:
  - OA `Core/Physics/Motion/MotionTableManager.cs:218-245` (`PerformMovement`), `:67-143` (add_to_queue / remove_redundant_links / truncate)
  - OA `Core/Physics/Motion/CSequence.cs:116-133`
  - AC `MotionTableManager::truncate_animation_list` :329842
* **Fix.** At `entities.js:10090`, drop the free and let the queue own the record. If an immediate cut is truly wanted, call `_unifiedOneShotFinished(inst, rec)` (or `animationsDone(q, rec.numAnims)`) before nulling the playhead. Add an integration test that drives `setMotion(A) → setMotion(Ready) → setMotion(B)` through `EntityManager`. `tests/motion_pending_queue.test.mjs` only tests the pure functions in `motion_queue.js`.

### P0-2. A locomotion change cuts an in-flight action; retail keeps the action and re-appends the cycle after it (HIGH)
* **Mechanism.** Retail `CMotionTable::GetObjectSequence` (AC :337641) handles a cycle change with `clear_physics` + `remove_cyclic_anims` (around :337795-337810). That removes only the cyclic tail; link and action anims that are already queued keep playing, and the new link and cycle are appended after them. The action branch (:337851-337856, double-hop :337895-337900) adds the action and then re-appends the current base cycle.
  OA mirrors this exactly: `Core/Physics/Motion/CMotionTable.cs:213-287` (cycle branch) and `:290-330` (action branch).
  HB:
  - Any `setMotion` frees the gesture (P0-1 site).
  - The tick gives the one-shot exclusive precedence over locomotion (`entities.js:15096` / `:15118`): two playheads instead of one sequence.
  - `index.html:10011` / `:11114` cancel the cast on any forward edge.
  So in HB, movement during a swing or windup ends it; in retail it doesn't.
* **Fix.** Make locomotion append to the queue (retail `add_to_queue` happens for cycles too) instead of preempting. Long term, one sequence: link list, then cycle (see P1-1).

### P0-3. Why the H4 "invisible animation break" can't happen in HB: the cycle-collapse never reaches the live playhead (HIGH)
* **Mechanism.** Retail's break is `remove_redundant_links`, triggered by a pure-cycle node (for example RunForward re-issued). It walks back to an earlier node with the same motion. It passes the cast gesture node, because `0x4000002C & 0xB0000000 == 0`. It is blocked by windup actions (`0x10…`) and by turn/strafe modifiers that carry anims (`0x65…`). It then calls `CSequence::remove_link_animations` (AC :339954) on the live sequence, which snaps the playhead onto the cycle.
  So the break only works during the cast gesture, and only with no intervening modifier: "straight line only, in the gesture window".
  - OA implements this end to end: `MotionTableManager.cs:73-143` → `CSequence.cs:116-133`, which moves `_currAnim` to `_firstCyclic`.
  - HB has two blockers.
    (1) Locomotion never enters `_unifiedQueue`; only attack and cast one-shots do (`entities.js:12492`). So no cycle node exists to trigger the collapse.
    (2) The deviation documented in `scene3d/motion_queue.js:50-56` and `:116-119`: `truncateAnimationList` never touches the started head.
  DEC-17 calls this "the same observable outcome". For H4 it isn't: H4 is precisely the retraction of the in-flight gesture.
* **Fix.** Enqueue locomotion cycle nodes (with their anim counts) in the same queue. Let truncation retract the in-flight head by snapping the playhead to the locomotion cycle, which is what retail's `remove_link_animations` does. Then delete the non-retail forward-edge `cancelCastSequence("anim-break")` (`index.html:10011` / `:11114`). That path breaks on any forward edge, curved or straight, during any part of the chain, which is broader than retail.

### P0-4. `MaybeStopCompletely` is never called on cast or attack request (HIGH) — the likely root cause of "run as far as you want and cast" and the 3x slidecast speed
* **Mechanism.** Retail calls `cmdinterp` `MaybeStopCompletely` in three places:
  - `ClientMagicSystem::FreeHandsAndCastSpell` (AC :403775)
  - the untargeted branch of `CastSpell` (:404671 body)
  - `ClientCombatSystem::StartAttackRequest` (AC :408917)
  `MaybeStopCompletely` (AC :717557) → `StopCompletely` → ClearAllCommands, SetAutoRun(0), `CPhysicsObj::StopCompletely`, then a movement event to the server. It is a no-op while `controlled_by_server` is set.
  This is why retail slidecasting needs held chords plus re-tapping (owner H2): the cast press wipes the held commands.
  - OA calls it every time: `Runtime/Gameplay/RuntimeSpellCastState.cs:135` → `PrepareAttackRequest` → `PlayerMovementController.cs:945-952` (`StopCompletelyAtPhysicsObjectBoundary`, server-control guard), and the movement is sent at `GameRuntime.cs:810-822`. Attack does the same at `RuntimeCombatAttackState.cs:382`.
  - HB has the port, `crates/holtburger-core/src/client/movement/command_interpreter.rs:1166-1173 maybe_stop_completely`, but it is marked `#[allow(dead_code)] // staged` and has zero callers. Neither cast path (`scene3d/picking.js:1032`, `ui/ac_cast_spell.js:121-125`, `plugins/hotbar.js:667`) nor `fireAttackOnSelectedTarget` stops the player.
  Consequence: held movement keys survive the cast press. That is consistent with the HANDOFF-07-13 "13–16 m/s, ~3x retail" slide anomaly and foundation symptom #3.
* **Fix.** Expose a wasm `maybeStopCompletely()` and call it immediately before every `castTargetedSpell` / `castUntargetedSpell` / attack send. Do it at request time, not at server echo.

### P0-5. Missile still predicts the swing locally and its echo is never de-duplicated (MEDIUM-HIGH)
* HB `scene3d/picking.js:1438-1446`: after `missileAttack`, it calls `em.setSwingMotion(localGuid, finalMotion)` + `noteLocalSwingPrediction`. This is NOT gated by `SERVER_SWING` (`:223`); melee is gated (`:1562`).
* ACE sends the aim motion as a persisted forward cycle (`Player_Missile.cs:227` `EnqueueMotionPersist(actionChain, aimLevel)`), with `AimLevel = 0x4000001E` (a cycle). That rides KIND_MOTION, whose local dedup covers only lows `0x2B..0x39` (`scene3d/loop.js:299`). The action-arm dedup at `loop.js:3532` never sees it.
* ACE also `Rotate`s before launching (`Player_Missile.cs:126-138`), so even a matching echo arrives later than 500 ms. The bow animation therefore double-plays (prediction at click, echo after rotate+RTT), and the echo passes through the P0-1 free/zombie path.
* Retail and OA play no local missile motion: `ClientCombatSystem::ExecuteAttack` AC :408626 only sends; `OA Core/Combat/CombatAnimationPlanner.cs:8-12` `PlanForEvent` returns `None`.
* **Fix.** Gate the missile prediction exactly like melee (`!SERVER_SWING`), or delete it. The CMT/aim-level code can stay as diagnostics only.

---

## P1 — structural divergences (explain "by feel" residue; not single-line bugs)

### P1-1. One-shots are baked "from Ready", full-body, with no out-hop or return-hop
* HB:
  - `entities.js:10410` `_tryPlayLink(…, READY_SUBSTATE, linkCmd, …)`
  - `setSwingMotion` passes `fromMotion: READY_SUBSTATE` (`:9592-9596`)
  - the one-shot owns the whole rig (`:15096-15110`)
* Retail action branch (AC :337851 / :337895; OA `CMotionTable.cs:290-330`): link from the CURRENT substate. With no direct link it goes out-hop to the style default, then the action, then the return-hop to the old substate, then the base cycle.
  Casting or swinging while running should therefore play Run→Ready, action, Ready→Run. HB pops into a Ready-relative clip and freezes the legs.
* Aim (`0x4000001E..`) and Reload (`0x40000016`) are cycles in retail: link from the current substate plus a held cycle. HB plays them as cycle-as-one-shot from Ready (`entities.js:9573` `_tryUnifiedCycleOneShot`). (Medium confidence: whether an AimLevel→Reload link exists still needs a DAT check.)

### P1-2. Two `pending_animations` queues that never talk to each other
* The Rust `crates/holtburger-core/src/client/movement/motion_table_manager.rs` (which drives slidecast/forward-slot arbitration) completes nodes on an authored-length clock (`RENDERER_DONE_FALLBACK_SECS`, `:69` / `:113` / `:130`). The renderer `AnimationDone` bridge (`entities.js:2075-2084`) fires only for `opts.mtQueued` keys, and the comment at `:12549-12553` says no caller passes that.
* Meanwhile the JS `_unifiedQueue` is the actual playback authority.
* OA has one queue, fed by the sequencer's AnimDone hook (`Core/Physics/AnimationSequencer.cs:294-297` → `MotionTableManager.AnimationDone` `:145-167`).
* **Fix direction.** Make the JS playhead call `notifyAnimationDone` per finished anim, or move the playhead into Rust (the "system work in Rust" rule) and keep a single queue.

### P1-3. The server-action dedup should be the action stamp, not wall-clock windows
* Retail `CMotionInterp::move_to_interpreted_state` (AC :344372) filters actions by the 15-bit `server_action_stamp` (with wrap) and skips autonomous actions for the player. OA does the same: `Core/Physics/MotionInterpreter.cs:1060-1097`.
* HB already has the stamp logic: `crates/holtburger-core/src/client/movement/motion_interp.rs:239`, `:694-705`, plus `MOTION_ACTION_STAMPS` (`src/lib.rs:42383`).
* HB still runs the 500 ms `noteLocalSwingPrediction` / `consumeLocalSwingEcho` window (`entities.js:8552-8571`, `loop.js:3441-3456` and `:3532`). After DEC-6, serverSwing and P0-5, nothing should be predicted locally, so all of it can be removed.
* The same goes for the `castGestureParity` block. It is dead since DEC-6 because nothing notes the cast gesture any more.

---

## P2 — spellcasting specifics

* **P2-1. Synthetic CasterEffect still double-fires by default (HIGH).**
  - HB `CAST_SYNTHETIC_CASTER_VFX` defaults on (`entities.js:1561-1568`), and the chain-end emit is at `:9012-9040`.
  - ACE already broadcasts the effect to the caster at release (`WorldObject_Magic.cs:358-359`; ledger E6), so about 74 spells with CasterEffect play it twice, and the local copy fires at the client's estimated time.
  - Retail and OA have no client emit.
  - **Fix:** flip the default (the code comment itself says flip once E1 is confirmed, and E6 confirms it).
* **P2-2. `playCastSequence` is still a wall-clock shadow chain (MEDIUM).**
  - HB `entities.js:8662-9058`. It sleeps per-gesture estimates, owns the busy window (`:8701-8734`), the WS04 forward-slot hold (`:8781-8800`), `spellCastResolved` and the CasterEffect.
  - Retail and OA keep only a busy count: increment on send (AC :403775; OA `RuntimeSpellCastState.cs:152`), decrement on `UseDone` (OA `CompleteUse` `:170-203`).
  - ACE decides a fizzle at release, and `FinishCast` broadcasts Ready plus `UseDone` about 1.0 s later (`Player_Magic.cs:874-882`, `:916-918`, `:937-991`). The authoritative end-of-cast is therefore `UseDone`, not the client's estimate.
  - **Fix direction:** drive busy, the cast window and the "resolved" event from wire events (UpdateMotion actions plus UseDone/WeenieError) and retire the timers.
* **P2-3. The client fabricates a Ready recoil on fizzle, reject or anim-break (MEDIUM).**
  - HB `entities.js:9136-9141` calls `setMotion(Ready)` locally. This is also a P0-1 zombie trigger.
  - ACE sends its own `Motion(Magic, Ready)` in `FinishCast` (`Player_Magic.cs:978-979`) after a fizzle, because a fizzle still goes through `FinishCast`. Retail plays only the `PlayScript.Fizzle` it receives.
  - **Fix:** don't synthesize motion; let the wire Ready arrive.
* **P2-4. The client turns before sending the cast (known; still default-ON) (MEDIUM).**
  - HB `picking.js:1079` `turnToFaceThenAct(guid, doCast, CAST_FACE_TARGET)` holds the wire send until the turn finishes (`:1231+` helper; `CAST_FACE_TARGET` `:73-77` reads `!== "off"`).
  - Retail sends immediately (AC :404671 → :403775), and ACE `Rotate`s the caster itself.
  - Missile has the same pattern: `picking.js:1457` with `MISSILE_FACE_TARGET` (`:46-50`).
  - This adds turn latency before every cast or shot, and its `setMovementInput` turn fights held keys.
* **P2-5. Self-target promotion matches retail.** HB's self-cast promotion matches retail `CastSpell` (bitfield&8 → `FreeHandsAndCastSpell(spell, player_id)`, AC :404671 body). Untargeted (`InqTargetType == 0`) → `CastUntargetedSpell`. No change needed. OA `RuntimeSpellCastState.cs:95-105` matches too.
* **P2-6. Projectile spells: see M-2 to M-4.** Spell projectiles are `PhysicsState::Missile` objects that ACE never position-updates in flight (`WorldObject_Tick.cs:264-276`), so client physics is the only flight model.

---

## Melee

* **M-1. Power bar: HB fires the slider value immediately; retail charges up (HIGH).**
  - Retail:
    - `StartAttackRequest` (AC :408917) sets `requestedAttackPower=1` and calls MaybeStopCompletely, then starts building.
    - `GetPowerBarLevel` (AC :407919) is (now − start)/1.0 s, or /0.8 s when the interpreted style is DualWieldCombat `0x80000046`.
    - `EndAttackRequest` (AC :408952), in basic mode, commits max(slider, bar). If the bar is still below the slider it keeps loading and fires at the slider level. A charged swing above the slider is immediately followed by a second request at the slider level. A release while the server is busy is queued (`attackWhenResponseReceived`).
  - OA ports this verbatim (`Runtime/Gameplay/RuntimeCombatAttackState.cs:221-300`, `:328-366`, `:403-411`, `:442-493`; test names such as `EarlyRelease_KeepsLoadingToTheSetPowerBeforeCommitting` and `ChargedRelease_ImmediatelyFollowsWithTheBarSetting`).
  - HB sends `cb.powerLevel` at click (`picking.js:1245-1246`, `:1559`) with no build delay. A click while `attackInProgress` is set is dropped (`:1266-1270`), not queued. The meter is a cosmetic refill estimate (`plugins/combat-bar.js:1467-1474`, `:1997-2006`).
  - ACE enforces `NextRefillTime` only after a swing (`Player_Melee.cs:144-160`, `:367-372`). So HB's first swing goes out up to 1 s early, and a hold-to-charge flow doesn't exist.
* **M-2. Melee approach: client-side sticky pursuit at click (MEDIUM).**
  - HB `picking.js:1577-1579`: `stickToTarget` plus a 1 s re-engage watch (`:529-570`).
  - Retail `ExecuteAttack` (AC :408626) only sends.
  - ACE then either attacks directly when `dist<=4 && IsMeleeVisible` (`Player_Melee.cs:174-187`), or sends `MoveToObject` (`:200-209` → `Player_Move.cs:163-175`). The swing motion carries `StickToObject` + `TargetGuid` (`Player_Melee.cs:420-421`), which the client applies.
  - HB already handles both server paths faithfully: the MoveTo driver at `crates/holtburger-core/src/client/movement/system.rs:435-497` (`USE_SERVER_MOVETO_DRIVER=true`), and sticky-from-wire at `crates/holtburger-core/src/client/simulation.rs:775` / `:939-956`.
  - OA follows only the server orders: `Runtime/Session/RuntimeServerControlledLocalMovement.cs:51-94`.
  - The client pursuit is a second, non-retail driver. Removing it would leave ACE in charge, as in retail.
* **M-3. Attack-done semantics: nearly matching, one gap (LOW).**
  - ACE sends `AttackDone(None)` between repeats and `AttackDone(ActionCancelled)` at the end (`Player_Melee.cs:215-224`, `:375-385`). `CombatCommenceAttack` is sent only for subsequent missile shots (`Player_Missile.cs:196-200`).
  - OA ends repeat on a non-zero error (`RuntimeCombatAttackState.cs:448-449`).
  - HB clears the lockout on any `attackDone` (`combat-bar.js:1452-1466`), which is fine, and emits its own client-side `combatCommenceAttack` at click (`picking.js:1280`). The gap: HB doesn't distinguish end-of-sequence from repeat, so its "repeat" UI can't know the server stopped repeating.

## Missile

* **M-2b. Projectile flight model is too thin (HIGH for orientation and spin; MEDIUM for collision).**
  - HB `entities.js:5205-5219` seeds `lastVel` from the ObjectCreate velocity and sets `omegaZ: 0`. `_tickBallisticProjectiles` (`:14563-14594`) integrates position only, adding −9.8 m/s² when the spawn's GRAVITY bit is set. It applies no orientation update, no omega, no collision and no elasticity. The only stop is the impact VectorUpdate (`:11090-11105`).
  - ACE sets `AlignPath=true` + `PathClipped`, and when `RotationSpeed != 0` sets `AlignPath=false` and `Omega = 2π·RotationSpeed` on X (`Creature_Missile.cs:352-383` `SetProjectilePhysicsState`; `SpellProjectile.cs:77-79`, `:124-125`).
  - OA steps a real `PhysicsBody`:
    - `Core/Physics/ProjectilePhysicsStepper.cs:66-146` (MaxQuantum substeps)
    - `:210-221` (`calc_acceleration`, `UpdatePhysicsInternal`, AlignPath → `SetVectorHeading`)
    - `:280-322` (sphere `ResolveWithTransition` against the world plus `HandleAllCollisions`)
    - the body is built from the wire velocity, omega, friction and elasticity at `App/Physics/ProjectileController.cs:185-224`
    - test names `Advance_RotatingProjectileWithoutAlignPathKeepsOmegaSpin`, `Sweep_ThinBspWallStopsInelasticProjectile`, `Sweep_DownwardProjectileCollidesWithTerrainFloor`
  - Visible results in HB: arrows keep their launch pitch through a gravity arc instead of nosing over, thrown weapons and spinning bolts don't spin, and bolts fly through walls and terrain until ACE's impact or delete.
  - **Fix.**
    1. Per tick, set the yaw/pitch to the velocity direction when AlignPath is set (the PhysicsState bit is on the wire).
    2. Integrate `omega` from PhysicsDesc.
    3. Optionally sweep a sphere against the Rust spatial scene, which already has transition code (`crates/holtburger-world/src/spatial/transition.rs`). Per the "system work in Rust" rule, the projectile stepper belongs in Rust.
* **M-3b. Ammo, reload and visuals are server-driven and largely mirrored.**
  - ACE `Reload` / `Ready` persisted motions, `ParentEvent` re-arm and `PickupEvent` hide: `Player_Missile.cs:265-276`, `:335`.
  - HB handles both events (`crates/holtburger-world/src/handlers/inventory.rs:82+`; `src/lib.rs:27009`).
  - The remaining risks are the P0-1 zombie on Reload/Ready and P1-1 (cycle-as-one-shot from Ready).
* **M-4b. Aim-level ladder** is already faithful (ledger L1-5). With P0-5 fixed it becomes diagnostic only, as in retail.

---

## Suggested order
1. P0-1. A one-line class of bug with a large blast radius. Confirm with a live 3-cast run polling `inst._unifiedQueue.list[0].payload.seq.__wbg_ptr === 0`.
2. P0-4. Wire `maybe_stop_completely` on cast and attack send.
3. P0-5 + P2-1. Flip two defaults or delete two predictions.
4. P0-2 / P0-3 / P1-1 / P1-2 together, as one change: a single per-entity sequence plus the retail queue with live retraction, owned by Rust. This is the real H4 enabler.
5. M-1 power bar; M-2b projectile orientation, omega and collision.
