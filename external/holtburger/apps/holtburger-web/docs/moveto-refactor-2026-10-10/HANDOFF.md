# MoveTo refactor — handoff (2026-10-10)

Companion to `INVESTIGATION.md` (same folder). This records what landed, how to turn each piece off, what was
tested, and what still needs eyes on the 1070.

Owner decisions this work follows (verbatim answers to the investigation's six questions):
1. the stack lives in holtburger-world;
2. body speeds come from the motion tables;
3. remote collision as OpenAC / the decomp do it;
4. drop the client-side JS sticky-melee approach and rely on ACE's charge MoveTo;
5. JS animation authority — "you can decide how far you want to go with it";
6. native CLI parity is not required.

Nothing is committed. A cumulative patch per phase is in `/mnt/wbterminal2/holtburger-scratch/moveto-refactor/`
(`phaseA.patch` … `phaseG.patch`, with the gate logs beside them).

## 1. What changed, by phase

| Phase | What | Escape |
|---|---|---|
| A | The movement stack (`motion_interp`, `move_to`, `movement_manager`, `motion_table_manager`, `params`, `interp_state`, `raw_state`, `movement_types`, `move_to_nodes`) moved from holtburger-core to `holtburger-world/src/motion/`. Core re-exports it under the old paths. No behavior change. | — |
| B | **Per-object spine.** Every remote object owns one retail `MovementManager` in the world scene (`RemoteMover`). UpdateMotion and the ObjectCreate movement buffer unpack into it. The body moves by its own interpreted motion through its motion table (`motion::root_motion`). Its MoveToManager steps after the move (turn node → overshoot snap → run along the facing → 20° aux turns → arrival stick). A remote TurnTo is a turn, not a heading snap (the world handler snap and the KIND_TURN JS ease are skipped). AnimationDone for a remote reaches its own mover. | `?remoteSpine=off` |
| C | **Remote transition sweep.** A remote moved by its own motion within 96 m of the local player goes through the retail transition with its own `OBJECTINFO`: Setup spheres and step heights × scale, EDGE_SLIDE from PhysicsState 0x400000, ethereal, weenie bits. It uses the local player's gates. Walls, objects and step-up/down now apply, and indoor remotes move between corrections. | `?remoteSweep=off` |
| D | **Local MoveTo by its motion, COL-10 reverted.** An ACE MoveTo on the local player moves the body by the local interp's own motion. An ACE charge runs at 4.0 × 1.5 × the envelope run rate (D-1), along the facing with retail's aux turns (D-3). Turn nodes use the table rate × the player's real hold key. The bot's client pursuits and an active stall-recovery attempt keep the old steer. Walking (manual and MoveTo) now uses the table walk, 2.6017 m/s, instead of 3.12. The walk clip plays at `forward_speed` on every rig, players included. | `?localMoveToMotion=off` (MoveTo); `?creatureGait=off` (clip cadence) |
| E | **Remote rig speed.** Remote MoveTo phase edges carry the node's own speed, so a charging mob's run cycle plays at `params.speed` × its run rate in step with its body. | `?remoteMoveToPhase=off` (whole channel) |
| F | **Melee approach = ACE's charge.** picking.js no longer runs the player up on the StickyManager (`stickToEntity` and the 250 ms re-engage watch are deleted); a melee click only sends the attack. A local sticky-bit MoveToObject no longer sticks at arm time; it sticks on arrival, as retail does. The `stickToEntity` export stays for rynth. | `?localMoveToMotion=off` restores the arm-time stick. The JS run-up is gone (git history) |
| G | **TargetManager voyeur.** A MoveTo (remote spine and local driver) steers at what its target reports: a predicted position (pos + realized velocity × the mover's ETA quantum), at most every 0.5 s and only past 0.5 m. The mover re-tunes the quantum to its own time-to-target. Remote bodies now carry retail `cached_velocity`. | `?targetVoyeur=off` |
| H | D-9 comment fixed (`LoseControlToServer` runs `FinishJump`, not `ClearAllCommands`). Flag rows added to `docs/url-flags.md`. This doc. | — |

All new switches are default-ON in the wasm (struct defaults off, so native/CLI behavior is unchanged except Phase D's
walk speed, which is shared code).

## 2. Verification

- Rust: holtburger-world 1025 passed, holtburger-core 581 passed + 1 ignored, holtburger-web native 328 passed.
  Before the refactor: world 876, core 703, web 324. Phase A moved the stack's tests from core to world
  (world 1001, core 577). `cargo check --target wasm32-unknown-unknown` and the CLI + tools check are clean.
- JS gate (`harness/run-js-headless.mjs`, capped): 515 passed, 0 failed.
- `scripts/lint-url-flags.mjs --strict` clean; `audit-flag-defaults.mjs --mismatch` exit 0.
- Release wasm built and swapped into `pkg/` (7.16 MB). The previous `pkg/` is in `pkg-prev-20261010-premoveto/`.
  Roll back with `rsync -a --delete pkg-prev-20261010-premoveto/ pkg/`.
- **Not done:** any live/browser run. Load with `?nosw=1` (the service worker caches the old bundle); the bake worker
  holds its own wasm, so do a full reload.

New tests: `spatial::remote_spine_tests` (11), `spatial::remote_transition::tests` (3), `state::remote_movement::tests` (3),
`motion::root_motion` (4), `motion::target_voyeur` (2), core `local_charge_*` / `local_moveto_*` (4), and JS updates in
`creature_gait_retail`, `remote_moveto_phase`, `remote_moveto_sticky_arrival`, `remote_jump_arc`.

## 3. 1070 eye-test queue (batched, off-screen per the owner rules)

1. Monster chase outdoors: turn in place → run → stop at reach; the run cycle in step with the body (no slide); the
   chase curves (aux turns) instead of sliding sideways.
2. Monster chase indoors / around a building: the mob moves between updates, stays out of walls, steps up stairs.
3. Melee click on a distant mob: ACE's charge runs the player at ~1.5× run (D-1), stops at reach, swing fires; no
   double approach.
4. A held W during a charge cancels it cleanly (0x36) and walking resumes.
5. Walking speed and feet: walk ≈ 2.6 m/s with planted feet on the local rig and remote players; backstep plays the
   walk reversed at 0.65.
6. NPC TurnTo (a vendor/emote turn): a smooth turn at the table rate, no snap, no wrong final heading.
7. A crowd (a spawn camp) for cost: `remoteSweep` runs a transition per moving remote per slice within 96 m. Compare
   `?remoteSweep=off`.
8. A kiting target: chasers lead it (voyeur ETA) without oscillating; compare `?targetVoyeur=off`.

## 4. Known gaps and next steps

- **Two local interps (investigation P2) are not merged.** The local MoveTo drives the body from the registry interp,
  and manual input from the CommandInterpreter lane. The hold key is synced per tick as a stand-in.
- **Legacy lanes are still compiled** (D5 `drive_remote_movetos` / `RemoteMoveToDrive`, the MoveTo locomotion hint,
  kind-67 hint re-apply, COL-20, KIND_TURN for non-spine remotes). Delete them after the eye-test passes with the
  escapes unused.
- Aux turns while running are body-only; the remote rig shows no turn modifier (retail's turn modifier has no
  distinct clip for humans).
- The voyeur's 10 s TimedOut status is not modelled. An unresolvable target cancels 0x37 at once, as before.
- Interpolation corrections are not swept (retail sweeps them too). This was left direct to avoid wedging a body on
  its own correction.
- Native CLI: the spine, sweep and voyeur are off. Phase D (local MoveTo motion, walk speed) applies natively too.
- The stall recovery (bot-only) still perturbs only the old steer; under the new lane it takes over only while an
  attempt is active.

## 5. Cast-movement fixes (2026-10-11)

These followed the owner's report that A/D strafing during casts was broken and their paste of the PvP "rookie cast"
technique. All three shipped default-on. The owner then reported "regressions to the movement system", and fix 3 went
back to opt-in the same day.

| Fix | Flag | Default | What it does |
|---|---|---|---|
| 1 | `?slideCast=off` | on | A strafe or turn held into a cast rides through ACE's windup echoes. ACE's `Motion(wo, gesture)` carries only the gesture, and retail's server echoed the caster's own axes. |
| 2 | `?retailMoveToCancel=off` | on | Only a fresh key press cancels a server MoveTo/TurnTo; a held key does not. A held strafe pauses for the turn-to-target, the caster faces the target, then the strafe comes back. Side effect: holding W while using a door, NPC or corpse, or while attacking, no longer cancels the approach. ACE's charge runs you there. |
| 3 | `?castTakesControl=on` | **off** | Any non-autonomous self motion hands control to the server, as retail's dispatcher does. A key release mid-cast is deferred. |

**Why fix 3 is off.** Retail's reclaim at the end of a gesture needs a held key (`CommandInterpreter::UseTime`,
acclient.c:717595). Take the sequence: hold strafe, cast, release the strafe mid-cast. The release was deferred, and
with no key held there was no reclaim, so the body kept the fix-1 strafe until the next key press. A differential
harness (pre-refactor 4ab7d2de vs this tree, 33 ms frames through the real tick spine) measured it: still sliding
3.3 s after the release. It is pinned by `released_strafe_or_turn_stops_at_once_mid_cast`. With fix 3 off:

- releases apply at once;
- A/D swaps mid-cast follow the keys (`strafe_swap_mid_cast_follows_the_keys`);
- the forward tap still moves the caster a little.

The one thing lost is the "base cast" turn-tap lunge, where the press re-applies a held forward
(`rookie_slide_turn_tap_lunges_until_the_next_echo`, now opted in).

**Possible follow-up (not built).** A softer fix 3: a General echo takes control, a press re-applies every held key (the
lunge), but a release applies at once (no deferral). That restores the lunge without the stuck slide. It is not
retail's release path, so it needs an eye test.

Pre-existing, the same in 4ab7d2de: a stance change while running stops the run until W is pressed again. In the
harness, W held for 4 s after the stance message did not resume the run. A held strafe does continue, through fix 1.
With fix 3 on, the run continued (its reclaim with W held), and the softer fix 3 above would keep that.

### 5a. Decision (2026-10-11, evening): retail lock-and-revive

A code review found that fix 1 never reached production for a key held INTO a cast. Every cast and attack queues
retail's `MaybeStopCompletely` before the request (`session/commands/combat.rs` → `enqueue_stop_then_action`), which
clears the held-key lists unless the server holds control, and `?slideCast` re-applies only what is left in those lists.
The fix-1/2/3 tests passed because the harness's `SlideStep::CastRequest` never queued that stop. It does now.

The owner's account of retail settled the shape: "when you hit w once, it kind of helps free up movement for the slide
from side to side … if you hit w twice, it frees up too much movement where you can kind of start to work your way out
of the cast and start running forward". That is the decomp's lock-and-revive: every applied self UpdateMotion runs
`LoseControlToServer` (acclient.c:392828 → :716832), the held keys stay in the CommandLists but are paused, and the
next fresh press runs `TakeControlFromServer` → `ApplyCurrentMovement` (:716934), which re-applies every held key. The
repo's own retail oracle pins already encode it (`retail_behavior_tests.rs` sequences A and B).

| Flag | Was | Now (browser) |
|---|---|---|
| `?castTakesControl` | opt-in `=on` | **default ON**, `=off` escape |
| `?slideCast` | default ON | **opt-in `=on`** |
| `?retailMoveToCancel`, `?castHoldReclaim` | ON | unchanged |

- The stuck slide that turned fix 3 off was the PAIR: the deferred release kept the strafe that `?slideCast` had
  injected into the server state. With `?slideCast` off the echo itself stops the slide, and after a tap control is the
  player's, so a release applies at once (`released_strafe_or_turn_stops_at_once_mid_cast`). Do not run both on.
- Keys held from before the cast press are still cleared by it (retail); the base cast re-presses its keys each cast.
  While an echo holds control the next cast's stop is skipped, so held keys carry into a chained cast.
- With fix 3 on, the pre-existing stance-change stop above goes away (the reclaim with W held).
- Carrier split: the native `USE_SLIDE_CAST` (true) and the scene's `general_motion_takes_control` (false) keep the old
  pair for the native suite; `run_slide` installs the browser pair explicitly.
- Tests (system/tests.rs): `cast_press_clears_keys_held_before_it`,
  `held_keys_carry_into_a_cast_pressed_while_an_echo_holds_control`,
  `slide_cast_opt_in_rides_keys_pressed_after_the_cast_through_the_echoes`,
  `base_cast_echo_locks_and_a_tap_revives_the_slide`, and the reworked fix-2/3 tests.
- Eye test still owed (1070, batched): the base cast with taps, one and two W taps mid-cast, and a strafe let go
  mid-cast.

### 5b. Follow-up (2026-10-11, night): forward "a little too easily"

The owner found forward came too easily in the slide combos. With `?castTakesControl` on, every cast echo hands
control to the server and ANY key press takes it back with retail's `ApplyCurrentMovement` (acclient.c:717027), which
replays a held W, so each turn, strafe or Shift tap mid-cast lunged forward. `?castHoldReclaim` only scoped the
automatic `use_time` reclaim. It now also scopes the press reclaim: during a known cast window a press off the forward
axis revives the held strafe and turn and keeps a held W/S dead; a W/S press itself is untouched (one W tap moves you
a little, two run you out of the cast). OpenAC (`PlayerMovementController.TakeControlFromServer`) re-applies held
forward on every input edge, release included, so it is not stricter here; this is a holtburger extension for ACE's
PK fizzle radius, under the existing flag (`=off` restores the retail lunge). Tests:
`cast_hold_reclaim_turn_press_keeps_held_forward_dead`, `cast_hold_reclaim_forward_press_still_moves`,
`base_cast_echo_locks_and_a_tap_revives_the_slide` (with a `castHoldReclaim=off` lunge arm).
