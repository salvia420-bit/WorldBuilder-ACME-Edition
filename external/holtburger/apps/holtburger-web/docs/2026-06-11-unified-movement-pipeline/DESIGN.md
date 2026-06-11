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
