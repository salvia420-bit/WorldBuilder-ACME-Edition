# Unified Movement Pipeline — DESIGN (2026-06-11)

Mission: replace holtburger's four disagreeing movement sources (Rust integrator with its
own speed derivation, JS gait predictor in camera.js, procedural setSwingPose, separate
remote-entity path) with ONE retail-shaped pipeline, exactly as acclient runs it:

```
input / server                                            (a) physics integrator velocity
  -> RawMotionState                                      /
  -> CMotionInterp (apply_raw_movement / adjust_motion  /
     / apply_run_to_command / my_run_rate)              <
  -> InterpretedMotionState ---------------------------- \
                                                          (b) MotionTableManager.PerformMovement
                                                              -> CMotionTable.GetObjectSequence
                                                              -> rig animation (same speed_mod)
```

One speed_mod scales BOTH the translation and the animation framerate — the
anti-ice-skating contract (acclient.c:337431-337474 add_motion; CSequence::apply_physics
acclient.c:339860-339890). They cannot disagree, so the rig can never lead or lag the
integrator, and the integrator can never lead or lag ACE *if the run_rate inputs agree*.

Stage-1 acceptance (measured bug, docs/2026-06-05-movement-fixes/NOTES.md:33-54): wasm
integrator runs local player at ~7.7 m/s vs ACE authored run cycle base 4.000 (walk 2.602
exact); rig tracks integrator, leads ACE ~1.9x, ACE force-positions back → 1-2 m SNAPBACK.

All paths below are relative to
`/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger` unless absolute.

---

## 1. Architecture — Rust-core module layout

Principle: **extend the existing `crates/holtburger-core/src/client/movement/` system,
do not build a parallel one.** Large pieces are already ported (Dimension C):

- protocol `RawMotionState` / `InterpretedMotionState` with pack/unpack —
  `crates/holtburger-protocol/src/messages/movement/types.rs:448` / `:226`
- DAT MotionTable parser (cycles, links, `cycle_velocity_base_speed`, movement profile) —
  `crates/holtburger-dat/src/file_type/motion_table.rs:19,80,104,156,191`
- `SelfMovementKinematics` resolved from the player's MotionTable profile —
  `crates/holtburger-world/src/state/self_movement.rs:241-285`
- retail `MotionPhysics` / `MotionModifierStack` (combine_motion/re_modify) —
  `self_movement.rs:137-216`
- the ACE GetRunRate formula — `crates/holtburger-world/src/context.rs:67-74`
- the half-built retail direct-set path `USE_DIRECT_GROUND_VELOCITY` —
  `crates/holtburger-core/src/client/movement/system.rs:230-262`

### New/changed modules (all inside `crates/holtburger-core/src/client/movement/`)

```
movement/
  common.rs            (existing — keep; axis-speed helpers become thin wrappers)
  system.rs            (existing — the integrator; consumes InterpretedMotionState)
  raw_state.rs         NEW  — local-runtime RawMotionState (style, fwd/side/turn
                              command+speed+holdkey, current_holdkey, action list with
                              15-bit stamps + autonomous bit). Mirrors
                              RawMotionState::ApplyMotion acclient.c:332852-332921.
                              The protocol type in holtburger-protocol stays the wire
                              codec; raw_state.rs is the live struct it serializes from.
  interp_state.rs      NEW  — runtime InterpretedMotionState + ApplyMotion /
                              RemoveMotion (current_style, forward/sidestep/turn
                              command+speed, pending action FIFO).
  motion_interp.rs     NEW  — the CMotionInterp port. Owns raw_state, interpreted_state,
                              my_run_rate, server_action_stamp, standing_longjump.
                              Functions (1:1 with acclient.c):
                                apply_raw_movement        (344259-344298)
                                adjust_motion             (343746-343803)
                                apply_run_to_command      (343439-343483)
                                apply_interpreted_movement(344147-344221)
                                  — incl. my_run_rate refresh when
                                    forward_command==RunForward (344162-344163)
                                get_state_velocity        (343539-343594)
                                get_max_speed / get_adjusted_max_speed (343486-343536)
                                apply_current_movement    (344301-344315) raw-vs-interp gate
                                move_to_interpreted_state (344372-344426) server UpdateMotion
                                  — stamp compare 344398-344408, local-autonomy gate 344410
                                StopCompletely            (343597-343638)
                                DoMotion / set_hold_run   (344600-344666 / 344492-344523)
                              STAGE 2 AMENDMENT (A3-D1, 2026-06-11) additionally owns:
                                pending_motions queue / add_to_queue (343406-343437)
                                motion_done(success)      (343641-343676)
                                motions_pending / HandleExitWorld (343735 / 343679)
                                enter_default_state       (344560-344598)
                                PerformMovement dispatch  (344670-344720)
                                HitGround / LeaveGround   (344429-344455 / 344457-344490)
                                ReportExhaustion          (344318-344332)
                                jump cluster: jump_is_allowed / charge_jump /
                                  contact_allows_move / get_jump_v_z / jump
                                  (343295-343404, 343845-343974, 344224-344256)
                              (ACE 1:1 port = Physics/Animation/MotionInterp.cs:
                                PendingMotions :24, MotionDone :210, HitGround :175,
                                LeaveGround :192, ReportExhaustion :264, AddToQueue :390)
  motion_table_manager.rs STAGE 2 (A4-Q1 fold, 2026-06-11) — retail
                              MotionTableManager queue: AnimNode{motion,num_anims},
                              animation_counter, pending_animations,
                              add_to_queue/remove_redundant_links/
                              truncate_animation_list (acclient.c:330149/330079/
                              329842), animation_done (329873),
                              check_for_completed_motions (329960),
                              HandleEnterWorld/HandleExitWorld (329949/329940),
                              initialize_state Ready node (330172-330200).
                              ACE = Physics/Managers/MotionTableManager.cs
                              (PendingAnimations :13, AnimationDone :28,
                              CheckForCompletedMotions :63). Implementation is
                              A4-Q1/Q2's item; SPECCED HERE ONLY (see §3 Stage 2
                              completion-layer amendment) — never spec it twice.
  motion_sequence.rs   STAGE 2 — minimal GetObjectSequence-shaped output: given
                              (style, substate, speed_mod) emit "play cycle X at
                              framerate*speed_mod, sequence velocity = authored
                              cycle velocity * speed_mod" events for the rig.
                              Scope-gated per T9 (animation-deep-dive-2026-06-02.md:1152-1199):
                              minimal modifier-LIFO subset, NOT the full CMotionTable port.
                              Reuses MotionPhysics/MotionModifierStack already in
                              self_movement.rs:137-216 (move or re-export, don't duplicate).
  move_to.rs           STAGE 3 — MoveToManager (MoveToObject/MoveToPosition, wire
                              my_run_rate float per acclient.c:339569-339583).
```

### Integration with the existing integrator (not a parallel system)

`MovementSystem::tick` (system.rs:962-1060) currently realizes `PlayerDriveIntent` →
`local_velocity_for_state(heading, state, &capabilities)` (system.rs:1265;
common.rs:686-734). Under the new pipeline:

1. The wasm recv arm (apps/holtburger-web/src/lib.rs:38377-38417) still builds a
   `MotionState` from input; that becomes `RawMotionState` writes through
   `motion_interp.DoMotion` (same path retail input takes, acclient.c:344600-344666).
2. `motion_interp.apply_raw_movement` produces `InterpretedMotionState`.
3. **Velocity source swap**: system.rs's `target_velocity` is computed by
   `motion_interp.get_state_velocity()` instead of `local_velocity_for_state`. The
   30 Hz MAX_QUANTUM slicing (system.rs:1206-1228), step-up/down, edge-slide,
   ground-snap, collision consts in system.rs are untouched — only where the planar
   target velocity number comes from changes.
4. `common.rs:652-684` axis helpers are kept for tests/back-compat but stage 1 marks
   them as the legacy path behind the gate (see §3 Stage 1). They already encode the
   same constants (backstep 0.65, sidestep 1.248/clamp 3.0), so get_state_velocity
   should land within float-epsilon of them for identical inputs — that identity IS a
   stage-1 unit test.
5. `USE_DIRECT_GROUND_VELOCITY` (system.rs:230-262) is *absorbed*: its ON path is
   exactly "direct-set grounded planar velocity to the interpreted-state target". The
   unified pipeline IS this path generalized. It must NOT survive as a second
   competing speed source — stage 1 replaces its body with the motion_interp call and
   retires the const in favor of `USE_INTERPRETED_VELOCITY`.

Run-rate input: `motion_interp` does not compute run rate itself; it takes an
`InqRunRate` closure/trait (retail: weenie vfptr[13], acclient.c:343452-343455) wired
to `holtburger-world` `player_run_rate()` (context.rs:311-326), falling back to
`my_run_rate` exactly as retail does. Remote objects get `my_run_rate` from the wire
(apply_interpreted_movement refresh + MoveTo trailing float), never the local player's
skill — preserving F3-5 per-creature gait tempo (~/out/remaining.md).

Local-player autonomy semantics (motion_interp.rs):
- `apply_current_movement` uses RAW state only when last_move_was_autonomous + weenie
  gate (acclient.c:344301-344315) — server UpdateMotion movement for the autonomous
  local player is copied then immediately re-derived from local raw state (ignored),
  while server-listed ACTIONS replay only with newer 15-bit stamps and skip
  self-echoed autonomous actions (acclient.c:339543-339562, 344372-344426). This is
  the Rust-side formalization of what B9 does ad-hoc in JS today.
- TakeControlFromServer semantics (clear controlled_by_server, last_move_was_autonomous=1,
  StopCompletely + StopInterpolating; acclient.c:716934-716953) live with the existing
  server-control handling in client code, calling into motion_interp.StopCompletely.

---

## 2. THE VELOCITY CONTRACT

### Retail chain (Dimension A, acclient.c)

```
raw forward_speed (1.0, W held)
  → adjust_motion                       (343746-343803)
      WalkBackwards → WalkForward, speed *= -0.65
      SideStep speed *= (3.12/1.25)*0.5 = 1.248 ; Left → Right negated
      TurnLeft → TurnRight negated; RunForward passes through
  → if holdkey==Run: apply_run_to_command (343439-343483)
      run_rate = weenie InqRunRate || my_run_rate || 1.0
      WalkForward(speed>0) → RunForward, speed *= run_rate
      TurnRight speed *= 1.5 (fixed) ; SideStepRight *= run_rate, clamp ±3.0
  → InterpretedMotionState

ON-GROUND m/s  = MotionData.velocity (DAT-authored cycle base: run 4.000, walk 2.602)
                 × speed_mod (= interpreted speed, already run_rate-multiplied)
                 [add_motion 337431-337474; apply_physics 339860-339890]
RIG framerate  = AnimData framerate × the SAME speed_mod              [337465]
AIRBORNE/clamp = get_state_velocity (343539-343594):
                 v.x = 1.25 × sidestep_speed (SideStepRight only)
                 v.y = 3.1199999 × forward_speed (WalkForward)
                     | 4.0       × forward_speed (RunForward)
                 |v| clamped to run_rate × 4.0
                 (only physics consumer = leave-ground/jump path, 343806-344489)

run_rate = MovementSystem::GetRunRate(load, runskill, 1.0)            [713790-713803]
         = (LoadMod(load) × (runskill/(runskill+200) × 11) + 4) / 4
           runskill==800 → exactly 4.5; stamina==0 forces runskill=0 → 1.0
LoadMod  = 1.0 (load<1) | 2−load (1..2) | 0 (≥2)                      [296777-296793]
runskill = Quickness-formula base + init + ranks + enchant/aug terms  [443696-443770]
```

ACE is a 1:1 port: MotionInterp.cs:506-523/394-428/525-562/678-699, constants
BackwardsFactor=0.65, RunAnimSpeed=4.0, WalkAnimSpeed=3.1199999, SidestepAnimSpeed=1.25,
RunTurnFactor=1.5, MaxSidestepAnimRate=3.0 (MotionInterp.cs:26-32);
MovementSystem.cs:20-28 GetRunRate; EncumbranceSystem.cs:32-40 LoadMod.

### Our current chain (Dimension C)

```
camera.js _dispatchMovement (camera.js:1464-1517)
  → wasm setMovementInput (lib.rs:25761-25780) → SessionCommand
  → recv arm motion_state_for_input → PlayerDriveIntent::ManualHeld (lib.rs:38377-38417)
  → MovementSystem::tick (system.rs:962+) → local_velocity_for_state (common.rs:686-734)
      (Run, Forward) → resolved_manual_run_speed()
        = base_run_forward_speed (MotionTable-authored 4.000)
        × run_rate_scalar (self_movement.rs:44-46, 104-107)
      run_rate_scalar = player_run_rate() (context.rs:311-326)
        = run_rate_from_skill_and_burden (context.rs:67-74)  ← ACE formula, correct
```

### The divergence — pinpointed

**7.7 m/s is formula-correct.** 4.0 × GetRunRate(runskill≈100) = 4.0 × 1.9167 = 7.67 ≈
the measured ~7.7 (NOTES.md:33-54; derivation acclient.c:713801, CreatureSkill.cs:154-163).
The integrator constant chain is NOT inflated. The snapback is a **pipeline
disagreement on the run_rate INPUT plus rig decoupling**, two concrete defects:

1. **Run-skill input divergence (the stage-1 fix).** `player_run_rate()` falls back to
   the Quickness attribute when the wire Run skill hasn't populated
   (context.rs:320-323). ACE has no such fallback — it uses
   `GetCreatureSkill(Skill.Run).Current` (Monster_Navigation.cs:346-368;
   WeenieObject.cs:124-135), and retail's fallback on Inq failure is `my_run_rate`,
   not a Quickness synthesis (acclient.c:343452-343455, 443696-443770). Additionally
   wasm seeds `FALLBACK_RUN_RATE_SCALAR = 4.5` pre-stats (lib.rs:28415-28427) — a
   max-rate guess (GetRunRate(0,9999)=4.5) that holds until stats land. Whenever our
   run_rate ≠ ACE's run_rate, every grounded tick diverges position by
   4.0×|Δrun_rate| m/s and ACE's authoritative echoes pull us back.

   **Fix shape:** run_rate input = wire Run skill `Current` exactly as ACE composes
   it (formula base + init + ranks; stamina==0 → runskill 0 → 1.0); on
   unavailable, fall back to `my_run_rate` (last interpreted RunForward speed /
   wire MoveTo float), initial value 1.0 — NEVER Quickness, NEVER 4.5. Verify with
   the already-wired `playerRunRateInputs` probe (context.rs:335-366, lib.rs:28458,
   PROBE-RUNRATE.md) once the wasm is rebuilt (NOT this session).

   > ### DEVIATION — MOVE-RUNRATE-105, 2026-08-11: the order is REVERSED
   >
   > **Owner directive (verbatim, task-ORACLE session 3):**
   >
   > > adopt the server-provided run rate for the local player — retail-faithful
   >
   > The "Fix shape" above made the client-side composition the PRIMARY source
   > and `my_run_rate` the fallback. That order is now inverted for the local
   > player: `WorldContextExt::player_run_rate` returns the server's published
   > `my_run_rate` (`PlayerState::server_run_rate`, latched from a RunForward
   > self-motion's `forward_speed`) when one has been seen, and only falls
   > through to the composition otherwise. `?serverRunRate=off` restores this
   > document's order without a rebuild.
   >
   > **Why the reversal was called for.** The composition was measurably wrong:
   > the parenthetical "formula base + init + ranks" is short of ACE's
   > `CreatureSkill.Current` by `GetAugBonus_Base` + `GetAugBonus_Current`, and
   > on the oracle rig `AugmentationJackOfAllTrades = 1` put ACE at Run 110 and
   > us at 105 — rate 1.9758065 vs 1.9467213, the whole `run-hold-long`
   > −1.0% steady-speed FAIL (second-parity-report.md §S2.4).
   >
   > **What the decomp actually says** (recorded here because it contradicts
   > the directive's "retail-faithful" premise, and a later reader deserves
   > the evidence rather than the claim):
   >
   > * Retail DOES stamp the wire rate — `CMotionInterp::apply_interpreted_movement`,
   >   `if (interpreted_state.forward_command == 0x44000007) my_run_rate =
   >   interpreted_state.forward_speed` (acclient.c:344161-344162) — but only
   >   inside `unpack_movement`.
   > * `CPhysics::SetObjectMovement` (acclient.c:311186-311190) gates that
   >   unpack on `autonomous == 0 || !player_controlled`. For the LOCAL player
   >   (player-controlled) every autonomous frame is dropped before unpack.
   > * Every ACE self-motion frame carrying the rate is `autonomous == true`
   >   (measured: all seven retail pcaps, 2026-08-11 — `forward_command 7 →
   >   forward_speed 1.975806474685669`, `server_control 0`).
   > * So retail's local player never latches a rate this way. Its rate comes
   >   from the weenie `InqRunRate` vfptr → `CACQualities::InqRunRate`
   >   (:443696-443770), which is a LOCAL composition — one that includes the
   >   three augmentation terms this document's parenthetical omits.
   >
   > In other words: retail composes locally and lands on the server's number
   > because its composition is complete. **Both** repairs shipped, so the two
   > lanes now agree instead of one covering for the other:
   >
   > * **Fix A (the directive)** — server value first
   >   (`player_run_rate`, `?serverRunRate=off` escape).
   > * **Fix B (the root cause)** — `run_skill_augmentation_bonus` folds the
   >   `LumAugAllSkills` / `AugmentationJackOfAllTrades` / `LumAugSkilledSpec`
   >   terms into the composition, mirroring `InqRunRate` and ACE alike. This
   >   is a CONFORMANCE fix to this document's own stated intent ("exactly as
   >   ACE composes it"), not a reversal.
   >
   > Pins: `holtburger-core .../movement/retail_behavior_tests.rs::runrate_105`
   > (10 tests, incl. `t_retail_skips_the_autonomous_self_echo`, which encodes
   > the retail gate we are NOT honouring so the deviation stays executable).

2. **Rig decoupling (the stage-2 fix).** Retail scales the rig framerate by the same
   speed_mod that drives translation (add_motion acclient.c:337465). We instead have
   a JS keystate predictor (`_dispatchLocalRigMotion`, camera.js:1525-1567) + the B9
   local-echo skip (loop.js:1795-1860) + velScale reading an EMA of rendered XZ
   deltas (entities.js:~5596-5625) — the rig has no contractual tie to the
   integrator's speed_mod. Stage 2 exports the local InterpretedMotionState so the
   rig plays the cycle the pipeline chose, at framerate × speed_mod.

3. **Self-echo handling (audit item, stage 1).** ACE echoes GameMessageUpdatePosition
   to the owning client on EVERY accepted position update (Player_Tick.cs:513-516);
   a true force-position only advances the ObjectForcePosition/Teleport sequence
   (Player_Tick.cs:481-492; PositionPack.cs:44-56). The local player must hard-apply
   self echoes ONLY when those sequences advance; otherwise every prediction
   divergence becomes a visible 1-2 m snap even with correct speeds. Audit our
   recv-arm policy (the academy-rubberband "no-overwrite" policy already approximates
   this — NOTES.md:35-37) and formalize the sequence-gated rule in stage 1 tests.

Walk note: ACE's player constant WalkAnimSpeed=3.1199999 vs our MOTK-derived authored
walk base 2.602 (NOTES.md). The 3.12/4.0/1.25 constants are retail's closed-form
clamp/airborne approximations; **on-ground** truth is the authored MotionData velocity
× speed_mod (acclient.c:337445-337465). We keep authored cycle speeds (4.000/2.602) for
ground translation and use the constants only in get_state_velocity's clamp/airborne
role — that matches retail's actual ground behavior and our measured ACE positions.
(Also supersedes the JS WALK_FORWARD_SPEED=1.0 under-prediction, index.html:7940.)

### Contract statement (the one rule everything implements)

> `speed_mod = adjusted_raw_speed × run_rate` (run_rate from the SAME input ACE uses).
> Ground velocity = authored cycle base speed × speed_mod.
> Rig playback = cycle framerate × speed_mod.
> Airborne velocity & max-speed clamp = get_state_velocity constants × run_rate×4.0 cap.
> Self-echoed UpdatePosition applies to the local player only on
> ForcePosition/Teleport sequence advance.

---

## 3. Staged delivery plan

### STAGE 1 — interpreted-state core + velocity derivation (fixes the snapback)

Gate: `const USE_INTERPRETED_VELOCITY: bool = false;` at the top of
`crates/holtburger-core/src/client/movement/system.rs`, following the existing
const-gate pattern (USE_STEP_UP_DOWN etc., url-flags.md:245-273). Default OFF;
flipped after 1070 eye-test; on PASS integrated always-on and marked DONE in
url-flags.md per the passed-flag policy.

Files:
- NEW `movement/raw_state.rs`, `movement/interp_state.rs`, `movement/motion_interp.rs`
  (per §1; get_state_velocity, adjust_motion, apply_run_to_command, apply_raw_movement,
  apply_current_movement, move_to_interpreted_state, StopCompletely).
- `movement/system.rs` — under the gate, `target_velocity` comes from
  `motion_interp.get_state_velocity()` + authored-cycle ground composition; absorb and
  retire `USE_DIRECT_GROUND_VELOCITY` (system.rs:230-262).
- `crates/holtburger-world/src/context.rs` — **remove the Quickness fallback** in
  `player_run_rate()` (:320-323): unavailable → None; caller (capabilities install
  sites, common.rs:21) treats None as my_run_rate/1.0. Keep `run_rate_from_skill_and_burden`
  (:67-74) untouched — the formula is correct.
- `apps/holtburger-web/src/lib.rs` — change `FALLBACK_RUN_RATE_SCALAR` 4.5 → 1.0
  (:28415-28427) so pre-stats prediction under-runs (lags, self-corrects) instead of
  over-running (snaps). Note: lib.rs edits are inert until a wasm rebuild (out of
  scope this session; cargo check via `capped-build cargo check -p holtburger-web
  --target wasm32-unknown-unknown` only, single -p, never --workspace).

Tests (extend existing suites — system/tests.rs:81, common.rs:21 inline,
context.rs:19, world state/tests.rs:102):
- motion_interp unit tests pinned to acclient constants: WalkBackwards −0.65,
  sidestep 1.248 & ±3.0 clamp, TurnRight ×1.5, run_rate multiply, magnitude clamp
  run_rate×4.0, runskill 800→4.5, stamina 0→1.0, LoadMod piecewise.
- Identity test: for every (gait, locomotion, run_rate) cell,
  get_state_velocity-derived ground velocity == legacy `local_velocity_for_state`
  (common.rs:686-734) within 1e-5 — proves the swap is behavior-preserving where the
  legacy path was right.
- Regression pin: run_rate input with wire Run skill 100 → 1.9167 → 7.6667 m/s;
  Run skill unavailable → my_run_rate/1.0 → 4.0 m/s (the snapback scenario: never
  emit a skill-synthesized rate ACE doesn't hold).
- Echo-gate test: self UpdatePosition without ForcePosition/Teleport sequence advance
  does not overwrite the predicted local pose; with advance, it does.
- Stamp tests: 15-bit wraparound compare (window 0x3FFF), autonomous-echo skip.

Eye-test plan (1070, ALWAYS off-screen/headless-invisible; do NOT touch the
127.0.0.1:9224 driver from this work):
1. Headless lane first (laptop, Playwright chromium → 127.0.0.1:8765,
   `?nullRender=1` mandatory): post-rebuild read `playerRunRateInputs` JSON
   (PROBE-RUNRATE.md playbook) — confirm run_skill_source == wire_run_skill and
   run_rate matches ACE's GetCreatureSkill(Run).Current-derived value.
2. Headed capture (`:0` + xdotool windowactivate + pointer warp — the rAF trap,
   NOTES.md:26-31): W-run 30 s straight line; accept when integrator speed ==
   4.0×run_rate AND raw ACE UpdatePosition deltas agree AND zero force-position
   sequence advances (no snapback).
3. Walk gait, sidestep, backstep spot-checks (2.602×rate / clamps).

Supersedes: USE_DIRECT_GROUND_VELOCITY (absorbed); the friction-0.5/accel-cap-8
legacy steady-state path it documents; the Quickness fallback; the 4.5 wasm seed.
Preserves: all step/slide/collision consts, 30 Hz slicing, B9 (untouched in stage 1),
velScale, forceMotionLocal.

### STAGE 2 — rig animation driven from interpreted state (deletes the JS predictor)

Gate: JS URL flag `?interpRig=` default OFF + `WASM_EXPORT_MANIFEST_VERSION` bump
(F18-2) for the new export.

Files:
- NEW `movement/motion_sequence.rs` — minimal GetObjectSequence subset (T9
  scope-gate): style/substate classification by high nibble (0x8/0x4/0x1/0x2,
  acclient.c:337641-337909), in-place change_cycle_speed semantics when the same
  cycle continues with a speed change (337773-337780), modifier-LIFO via the existing
  MotionPhysics/MotionModifierStack. Land T7 (MotionData bitfield accessors) and T8
  (24-bit MOTION_KEY_MASK fix, motion_table.rs:8) first, per the deep-dive ordering.
- `apps/holtburger-web/src/lib.rs` — new export `localInterpretedMotion()` returning
  {style, substate_command, speed_mod, sidestep/turn commands+speeds} (+ event on
  change through the existing entity-update channel; load-bearing export → manifest
  bump in lib.rs + JS together).
- `apps/holtburger-web/scene3d/loop.js` — new local-rig arm: consume the wasm
  interpreted state → `em.setMotion(localGuid, cmd, speed_mod)`; the B9 skip
  REMAINS for server echoes (the skip exists because echoes disagree with
  prediction — the new source replaces the *predictor*, not the skip).
- `apps/holtburger-web/scene3d/camera.js` — delete `_dispatchLocalRigMotion`
  (:1525-1567) and the keystate→MotionCommand mapping under the flag.
- `apps/holtburger-web/scene3d/entities.js` — velScale's `_resolveStateGroundSpeed`
  cycleTimeScale (:~5596-5625) reads speed_mod from the interpreted state instead of
  the rendered-XZ EMA for the local player (T1 dep #1: the EMA "reads garbage during
  server-pose snaps"); remote entities keep their per-creature path (F3-5 — remote
  run rate rides vx on kind=5, loop.js:1859-1867; do not regress).

Tests: Rust — sequence-selection table tests (style change, cycle re-speed no
re-transition, action FIFO); JS — node --check + headless smoke that the local rig
receives RunForward at speed_mod while moving (closes the local-locomotion-anim GAP:
rig idle-while-moving, memory project_local_player_locomotion_anim_gap_2026-06-03).

Eye-test (1070, invisible): walk/run/strafe/backstep gait visually loops at correct
tempo, no crossfade churn (FIX1's failure mode), no foot-slide; jump arms-up pose
UNCHANGED (retail-correct, never revert).

Supersedes: camera.js predictor; the run-anim-loop motivation behind FIX1 (the skip
machinery stays until PASS, then the locomotion half of the KIND_MOTION local skip can
be simplified per the passed-flag policy); WALK_FORWARD_SPEED=1.0 / RUN_SPEED=4.5 JS
constants (index.html:7940, :10693-10717; camera.js:1122); velScale's local-player
EMA. Subsumes: local locomotion anim gap.

### STAGE 2 AMENDMENT (2026-06-11, survey A3-D1, folding A4-Q1/Q2) — the
### completion layer: pending queues, MotionDone, and the event fan-out

**Contradiction resolved (ROADMAP §7.3).** The original Stage 2 text scope-gated the
queue/completion machinery OUT while `interp_state.rs:31` shipped saying the action
FIFO is "drained by stage 2's PerformMovement". RULING: **Stage 2 owns the completion
layer.** The code comment stands as written; this amendment is the spec it was
pointing at. The original scope-gate survives only for the SELECTION algorithms
(motion_sequence.rs stays a minimal GetObjectSequence subset per T9) — selection is
scope-gated, completion is not. Without this layer one-shot actions never complete
pipeline-side: stuck action state, jump allowed while motions retail would refuse,
sticky never auto-released on action end (survey A3 §3 row 1, A4 §3 row 2).

**Two queues, one completion chain (this is ONE spec — A4-Q1/Q2 implement the
MotionTableManager half and the renderer wiring; they do NOT re-spec it):**

```
renderer clip end (three.js `finished` / LoopOnce overlay)
  -> [A4-Q2] notifyAnimationDone(guid, success) wasm export      (?mtQueue= flag)
  -> [A4-Q1] motion_table_manager.animation_done(success)
       pops AnimNodes with num_anims <= animation_counter        (acclient.c:329873)
       0x10000000 action bit -> MotionState::remove_action_head  (329892-329893)
  -> MotionDone(motion, success) fan-out                          (317097 -> 339349)
  -> [A3-D1] motion_interp.motion_done(success)                   (343641-343676)
       pops pending_motions head; if one-shot action (0x10000000):
       unstick_from_object hook + InterpretedState::remove_action
       + RawState::remove_action                                  (343652-343671)
zero-anim motions: check_for_completed_motions                    (329960)
  per-frame (UseTime tailcall, BN pseudo-C :290845-290850) AND
  synchronously after EVERY PerformMovement arm                   (344684-344704)
```

Seam contract (ROADMAP §2): **A4 owns WHO fires completion** (the
MotionTableManager queue, num_anims accounting, AnimationDone wiring from the
renderer, spam coalescing via remove_redundant_links/truncate_animation_list);
**A3 owns what completion DOES** (the CMotionInterp pending_motions pop and its
movement-state side effects). Execution order: A4-Q1 (queue core) → A3-D1
(MotionDone consumer) → A5-P1 (hook drain decides where `finished` fires) →
A4-Q2 (AnimationDone wiring).

**pending_motions semantics (motion_interp.rs, the A3-D1 half):**
- `pending_motions: VecDeque<PendingMotion { context_id: u32, motion: u32,
  jump_error_code: u32 }>` — retail `add_to_queue(context_id, motion,
  jump_error_code)` (acclient.c:343406-343437; ACE MotionInterp.cs:390).
- EVERY accepted `DoInterpretedMotion` enqueues a node (343993-344010); every
  `StopInterpretedMotion` enqueues a Ready (0x41000003) node (344056-344060) — stop
  completion is observable, not display-only.
- `motion_done(success)` pops the head; if the completed node is a one-shot action
  (`motion & 0x10000000`): unstick callback (A2 owns the sticky object itself — D1
  exposes a hook, does not own stick state) + `RemoveAction` on BOTH
  InterpretedState (interp_state.rs actions FIFO — THE drain that makes
  interp_state.rs:31 true) and RawState (raw_state.rs:184-225 arms exist).
- `motions_pending()` = head non-null (343735). `handle_exit_world` drains the
  queue through the same pop path with success=0 (343679; ACE :162-171) — pending
  one-shots are cancelled, not played, across teleport/portal (A4-Q3 wires the JS
  trigger).
- `enter_default_state` (344560-344598): reset both states,
  InitializeMotionTables-equivalent, **seed the queue with one Ready (0x41000003)
  node**, set initted, call LeaveGround — the construction semantics for every
  per-entity MotionInterp instance (Stage 3 needs this; ACE MotionInterp.cs:610-615).
- **6-action FIFO cap**: `DoMotion` refuses with error 69 when the action FIFO
  already holds 6 (344600-344666 `GetNumActions >= 6`) — the existing uncapped
  `InterpretedState.actions` VecDeque gets the cap here.

**Jump charge path (queue-coupled — why D1 must precede it):**
- Each queue node carries `jump_error_code` derived from
  `motion_allows_jump(motion)` at enqueue time (343993-344010, 343295-343316).
- `jump_is_allowed` (343922-343974) consults, in order: `contact_allows_move`
  (343882 — LogOut/Dead/LifestoneRecall-class motions exempt), IsFullyConstrained,
  **the pending-queue HEAD's jump_error_code** (ACE MotionInterp.cs:753-754), then
  `jump_charge_is_allowed` (343318-343341: weenie stamina vfptr → error 73;
  forward-command gate → 72) and `motion_allows_jump(forward_command)`.
- `charge_jump` (343845) sets `standing_longjump` only when on-ground + Ready + no
  sidestep/turn; `jump` (344224) cancels moveto, stamps `jump_extent`,
  `set_on_walkable(false)`; `get_jump_v_z` (343343): extent clamp 1.0, weenie
  scale, default 10.0. Our shipped gates (lib.rs:38260-38392, types.rs:64-72,
  :1710) already cover the non-queue terms (survey A3 §3 row 9 PARITY); the queue
  head's error code is the missing input this amendment adds. Charge-time stamina
  error 73 stays UNRESOLVED (ACE gates at release only — survey A3 §6); do not
  add a speculative charge-time gate.

**StopCompletely / PerformMovement dispatch:** `PerformMovement` (344670-344720)
dispatches DoMotion / StopMotion / DoInterpretedMotion / StopInterpretedMotion /
StopCompletely and calls `CheckForCompletedMotions` after EACH arm — a no-anim
motion completes inside the same call it was issued (ACE
MotionTableManager.cs:160). StopCompletely (343597-343638, already ported stage 1)
gains its queue interaction here: the stops it issues enqueue Ready nodes like any
other stop. The system.rs tick calls `check_for_completed_motions` after drive
ingestion, mirroring retail's per-frame UseTime pump (A4-Q1 file plan).

**HitGround / LeaveGround fan-out (motion_interp half; MovementManager fan-out to
MoveToManager is Stage 3):**
- `HitGround` (344429-344455): gravity-state check, RemoveLinkAnimations,
  `apply_current_movement` (re-derive on landing). NOTE: our per-tick re-derive
  (system.rs:1316) may behaviorally subsume this; do NOT add an event-driven
  HitGround unless A1's ordering audit shows a late-by-one-frame landing artifact
  (survey A3 §6) — spec'd here so the omission is a decision, not a hole.
- `LeaveGround` (344457-344490): stamp launch velocity =
  `get_leave_ground_velocity` (343806-343843) = `get_state_velocity` (closed-form,
  **clamped run_rate×4.0**) + `get_jump_v_z` z, falling back to the transformed
  physics velocity when ~zero; clear `standing_longjump`/`jump_extent`;
  RemoveLinkAnimations; `apply_current_movement`. This REPLACES our walk-off-ledge
  freeze of the unclamped `current_planar_velocity` (system.rs:1390-1398), which
  can exceed retail's clamp on diagonal run+strafe launches (survey A3 §3 row 6).
  Charged-jump departures already use interpreted intent (lib.rs:38441-38460) —
  unchanged.
- Decision recorded: ../2026-06-11-unification-survey/DECISIONS-A1-O5-constants.md (d)
  — HitGround omission CONFIRMED; LeaveGround clamp now owned by S6/D3-5
  `USE_LEAVE_GROUND_VELOCITY` (default-off).

**ReportExhaustion (survey A3-D2; (a) is a Stage-1 point fix, (b) lands with this
layer):** retail re-runs `apply_raw_movement`/`apply_interpreted_movement` on the
stamina-exhaustion event so run promotion re-resolves at the exhausted rate
(acclient.c:339421-339434, 344318-344332; ACE MotionInterp.cs:264, server side
stamina==0 → runskill 0 → GetRunRate 1.0 — the §2 chain this doc already pins).
(a) `player_run_rate()` (context.rs:317-334) gains the stamina input: wire Stamina
current == 0 → exhausted rate 1.0, behind
`const USE_EXHAUSTION_RUN_RATE: bool = false` (const-gate pattern,
url-flags.md:245-273) — without it the exhausted player keeps predicting full run
speed and the snapback class Stage 1 fixed returns exactly at stamina 0. (b) the
`report_exhaustion()` event re-derive on the 0-crossing, fanning to MoveToManager
once Stage 3 exists (ACE MovementManager.cs:159-162). Add the "stamina 0→1.0"
unit test the Stage-1 test list already promises but never shipped.

**Flags / rebuild / rollback:** Rust queue core behind
`const USE_MOTION_TABLE_QUEUE: bool = false` (A4-Q1); motion_interp consumption
rides Stage 2's `?interpRig=`; renderer wiring behind `?mtQueue=` + the
`notifyAnimationDone` export bumps `WASM_EXPORT_MANIFEST_VERSION` (F18-2; JS
consumer updated together). All default-off; rollback = flags off (queue inert,
current paths untouched). Wasm-rebuild batch R2 (queue core) + R4 (export).

**Tests (headless-now):** queue FIFO order; num_anims pop + counter reset;
redundant-substate truncation; zero-anim immediate completion;
Stop/StopCompletely enqueue Ready 0x41000003; enter_default_state Ready seed;
action pop removes raw+interp + fires unstick hook; 6-cap error 69;
jump_is_allowed refuses on head jump_error_code; exhaustion 0→1.0 re-derive.
1070-gated: one-shot completes → sticky release + jump allowed; spam-click
truncation (no crossfade churn); emote completes then gait resumes; no swing
carried through a portal; run to stamina 0 → no snapback.

### STAGE 3 — MoveToManager + server-motion unification (sticky / FU-3)

Gate: per-feature Rust consts default OFF.

Files:
- NEW `movement/move_to.rs` — MoveToManager: MoveToObject/MoveToPosition execution
  with the wire `my_run_rate` float (acclient.c:339569-339583; ACE
  MoveToPosition.cs:10,26 / MoveToObject.cs:12,30), turn omega rate-limited to
  retail turn rate × MoveToParameters.speed (the F3-3 noted refinement, replacing the
  fixed heading-ease K in KIND_TURN, lib.rs:18044).
- motion_interp server lane: route server UpdateMotion through
  move_to_interpreted_state for ALL entities (remote = takes effect; local autonomous
  = actions-only with stamp dedup), unifying the remote-entity path with the local one.
- FU-3/local combat: one-shot actions (0x10000000) flow through the same action FIFO
  → motion_sequence → rig, replacing procedural setSwingPose with real CMT links
  (cmtStanceMask/fullBodyOneShot flags fold in; classification stays in
  classify_motion_link_for_swing, lib.rs).

Tests: action-stamp replay/dedup matrix; remote MoveTo arrival within 5 Hz
UpdatePosition envelope (F3-2 stays deliberately deferred MED — this stage must not
silently "fix" it with a speculative remote driver; subsume only what the manager
needs). Eye-test: NPC turn-rate feel, sticky melee (F3-4 must not regress), local
swing/cast clips (fullBodyOneShot eye-test pending from 2026-06-11 session).

Supersedes: setSwingPose canned poses (behind cmtStanceMask), fixed-K turn easing.
MULTI-ACTION queue drain stays CAPTURE-GATED — build it only after a ≥2-action
UpdateMotion is observed on the wire (RESEARCH-REPORT.md:111-117).

### STAGE 3 AMENDMENT (2026-06-11, survey A3-D3) — unpack_movement completeness,
### MovementManager facade, enter_default_state

Stage 3's "route server UpdateMotion through move_to_interpreted_state for ALL
entities" must additionally spec (we DECODE all of this today; the semantics are
dropped — survey A3 §3 row 4; decode sites motion.rs:23-117, :163-176, :197-228):

- **Per-unpack preamble**: `cancel_moveto` + `unstick_from_object` before every
  UpdateMovement apply (acclient.c:339516-339518).
- **Style-change DoMotion**: when the unpacked style != `InqStyle()`, route a
  `DoMotion(style)` through the D1 lattice BEFORE the payload dispatch
  (339540-339546) — server style changes re-style the rig through one path.
  (Requires the Stage 2 amendment's DoMotion validation lattice: style-gated
  errors 63-66, 6-cap error 69, RawState::ApplyMotion on success,
  acclient.c:344600-344666 — hence D1 before D3.)
- **standing_longjump from the wire**: `standing_longjump = flags & 0x200`
  (339568) — our decoded `motion_flags` bit 0x02 (motion.rs:65-67, entity.rs:265)
  currently has ZERO consumers; this completes G-7/F1-6 wire-side.
- **TurnToObject fallback**: case 8 with a missing object falls back to
  `MoveToManager::TurnToHeading` with the packed heading (339595-339612).
- **MoveTo trailing `my_run_rate` float CONSUMED** into the per-entity minterp
  (339577-339589) — decoded-but-unconsumed today (motion.rs:197-228); preserves
  F3-5 per-creature gait tempo.
- **MovementManager facade shape** (339175-339250): one owner fanning
  HitGround/LeaveGround/ReportExhaustion into BOTH minterp and MoveToManager,
  UseTime → MoveToManager only, HandleUpdateTarget → MoveToManager only,
  MotionDone/EnterDefaultState → minterp only (ACE
  Physics/Managers/MovementManager.cs:38-178). Replaces the scattered entry
  points (recv arm lib.rs:38377-38417 + JS setMotion allow-lists, survey A3 §3
  row 7) so the completion pump runs synchronously after motion entry.
- **enter_default_state on every per-entity MotionInterp creation** (lazy-create
  + default-state first, 339192-339199; semantics in the Stage 2 amendment:
  Ready queue seed + LeaveGround). Per-entity instances, per-entity my_run_rate —
  no globals (§5 remote/local bleed risk).
- **Non-charged leave-ground velocity** switches to the clamped
  `get_state_velocity` form (Stage 2 amendment, HitGround/LeaveGround block).

Flags: per-feature Rust consts default OFF (this stage's existing pattern).
Tests (headless-now): unpack fixture matrix incl. the 0x200 bit, TurnTo fallback,
default-state seed; 1070-gated: remote MoveTo tempo, sticky release on action end
(F3-4 must not regress). Serialize with A13 on the recv arm (ROADMAP §3).

---

## 4. Wire compatibility (stage 1 invariant)

**Nothing on the wire changes in stage 1.** Specifically:

- MoveToState (F61C) senders stay byte-identical: built at system.rs:3148-3207 via
  `raw_motion_state_with_motion_style` (common.rs:83), edge-triggered on motion-state
  change. Wire speeds DELIBERATELY stay 1.0 because ACE re-applies adjust_motion +
  apply_run_to_command server-side — "sending it doubles up" (common.rs:627-633).
  motion_interp's interpreted speeds are LOCAL realization only; the raw state, not
  the interpreted state, is what serializes.
- AutonomousPosition heartbeat unchanged: 1 s cadence while moving
  (common.rs:23 AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL; armed system.rs:823; pumped
  simulation.rs:241-277 and the wasm TickMovement arm lib.rs:38418+), carrying
  Position + 4 sequence ushorts + contact byte exactly as ACE parses
  (GameActionAutonomousPosition / MoveToState.cs:30-52, RawMotionState.cs:50-95).
- Sequence/stamp invariants from movement-protocol Phase A stand: is_newer_u16
  directional 0x8000; RawMotionState count mask ((flags&0xFFFF)>>11);
  InterpretedMotionState ((flags>>7)&0x1F); JUMP +8 trailer stays (ACE expects 32 B);
  POS-1 velocity-before-placement order stays (acclient.c:323620 before :323631).
- The only stage-1 recv-side behavior change is the self-echo ForcePosition/Teleport
  sequence gate (§2.3) — a local-apply policy, not a wire-format change.

Stage 3's my_run_rate-from-MoveTo is also read-only on the send side.

---

## 5. Risks + retracted-fix landmines (Dimension D — do NOT resurrect)

Retracted / refuted — never re-implement:
- **FIX2 (JS predictor snapback fix)** — retracted; "wrong-direction AND nearly
  inert"; the camera RUN_SPEED knob is overridden by the reconcile lerp
  (NOTES.md:20-24, 38-43). The snapback is Rust-side. No JS speed fixes.
- **RECON-2** "drifted pose fed back forever" — refuted; constrain_local_pose_toward
  converges (scene.rs:110-164).
- **ACE-VELZERO-1** velocity-zero on force-stamp advance — refuted; retail
  BlipPlayer→SetPositionSimple has NO velocity zero (acclient.c:145242-145249);
  zeroing is teleport-only.
- **PRED-3** terminal-velocity clamp — absent in retail and ours.
- **JUMP +8 removal / POS-1 reorder** — wire invariants, never touch.
- **Aug-cap as snapback cause** — real bug, wrong lever: load_mod clamps at 1.0
  (context.rs:47-52), burden only brakes. Low-priority cleanup only.
- **velScale MOTK rebake** — settled misread; asset live, derivation 4.0; the
  cycleBaseSpeed=0 was an LRU cache-miss, fixed by prefetch (lib.rs ~4734). DON'T rebake.
- **Jump arms-up pose** — retail-correct (Trevis authoritative); flip-flopped twice
  already; stage 2 must not "fix" it.
- **F1-4 turn-direction semantics** — eye-test-gated, flip-flop history; do not touch
  without 1070 eyes.
- **POSITION-SEQ gate symmetry** — NO-GO, inert under TCP.
- **CHARGE /4.0 constant** — mirror ACE (commented out in Creature.cs:318); nothing
  speculative.

Implementation risks:
- **Run-skill hydration race**: removing the Quickness fallback means a window where
  run_rate=1.0 (under-prediction → lag, self-correcting) until wire stats land.
  Acceptable by design (retail behaves the same pre-Inq via my_run_rate), but verify
  login feel on the 1070; do NOT reintroduce a synthesized rate to mask it.
- **Walk-constant ambiguity** (3.12 vs authored 2.602): we ship authored-for-ground /
  constants-for-clamp (§2). If headed capture shows ACE walking us at 3.12-derived
  positions for players, revisit with measurements — not by guessing.
- **Double-application**: get_state_velocity's forward_speed is ALREADY
  run_rate-multiplied by apply_run_to_command. Multiplying run_rate again in the
  integrator is the classic 1.9× bug in the other direction. The identity test in
  stage 1 pins this.
- **B9 interaction**: stage 2 replaces the predictor, not the echo-skip. Deleting the
  skip before the new source is eye-tested PASS reintroduces the FIX1 crossfade churn.
- **Remote/local run-rate bleed**: F3-5 fixed remote creatures using the LOCAL
  player's run rate — motion_interp instances must be per-entity with per-entity
  my_run_rate; no globals.
- **Measurement traps**: unfocused/headless rAF throttling fakes speeds (the bogus
  3.87 m/s); headless lane requires ?nullRender=1; getLocalPlayerPose returns the
  integrator, not raw ACE — raw-ACE deltas must come from the recv arm/UpdatePosition
  instrumentation before declaring stage-1 PASS.
- **Build/process**: 8 GB laptop — capped-build, single `-p`, never --workspace; no
  wasm-pack this session (lib.rs changes are staged-inert until a buildbox/capped
  rebuild); new load-bearing exports bump WASM_EXPORT_MANIFEST_VERSION; default-OFF
  const gates; on eye-test PASS integrate always-on + mark DONE in url-flags.md.

## 6. Watch-items — pre-hydration fallback capabilities (F1-7 / grind-loop G-3, 2026-06-11)

Audited against the Stage-1 reality (`FALLBACK_RUN_RATE_SCALAR` = 1.0,
`player_run_rate()` returns `None` pre-hydration — no Quickness fallback —
and `resolve_self_movement_capabilities()` errors with `RunRateUnavailable`
so the integrator FREEZES when no override is installed). Verdict: the
pre-hydration story is already correct and freeze-proof; the values are now
single-sourced.

**The story (all in `lib.rs`, single-sourced in
`fallback_self_movement_capabilities()`):**
1. **Install at construction** — BOTH world-construction paths (eager
   SelectCharacter arm, lazy PlayerCreate arm) install the fallback caps
   override immediately, so there is no tick where the integrator can see
   `Err(RunRateUnavailable)` and freeze.
2. **Clear + re-test on hydration** — the PlayerDescription arm (and the
   cached-replay backstops in both construction arms) clears the override
   and probes `resolve_self_movement_capabilities()`; if the real biota
   doesn't resolve, the same fallback is re-installed.
3. **Per-tick watchdog** — the TickMovement arm re-installs the fallback if
   caps resolution ever regresses to `Err` mid-session (logged at tick%60).

**Value audit:**
- `run_rate_scalar: 1.0` — references `FALLBACK_RUN_RATE_SCALAR`; matches
  retail `my_run_rate` initial (CMotionInterp ctor; Inq-failure fallback
  acclient.c:343452). Pre-stats prediction UNDER-runs and self-corrects —
  correct by design, do NOT resurrect a synthesized rate (see §5).
- `base_run_forward_velocity` y=**4.5** — pre-MOTK guess; the human
  MotionTable RunForward cycle derives **4.0**. With scalar 1.0 a skill-0
  character could over-run ~12.5% for the (sub-second) pre-hydration
  window; hydrated characters still under-run (real rate ≥ ~1.9). WATCH:
  if a 1070 capture ever shows a login-window snap, drop 4.5 → 4.0 behind
  a default-off gate (it changes default movement behavior); not worth the
  flag churn on the current evidence.
- `base_walk_forward_velocity` y=1.0, turn omegas ±1.5 rad/s — same
  pre-MOTK-guess provenance, same sub-second exposure; real MT values take
  over on hydration.
