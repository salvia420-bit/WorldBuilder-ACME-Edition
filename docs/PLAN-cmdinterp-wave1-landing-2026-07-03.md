# PLAN — cmdInterp wave-1 landing (2026-07-03)

Working plan for the integration session executing
`docs/PROMPT-cmdinterp-integration-2026-07-03.md`. The work order and rulings
live in `docs/movement-port-wave1-verdict-2026-07-03.md` +
`~/from-vm/wave1/QUALITY-integration.md` (SC-1..21, ADJ-1..16, M1..M8); this
file adds only what the prompt demands the integrator produce: the ownership
handover table, the step ledger, and session decisions.

## Ownership handover table (the conflict contract)

Scope: every piece of state BOTH lanes touch. "Legacy lane" = today's
`setMovementInput` → `ManualSet` → castMove/slideCast path (byte-identical
while `?cmdInterp` off). "Interp lane" = `?cmdInterp=on`. Rule: when the
interpreter lane is ON, exactly ONE writer exists per row; both lanes must
never drive in the same tick (debug_assert added in Step 4).

| # | State (site) | Legacy-lane writer (flag OFF — unchanged) | Interp-lane writer (flag ON) | Handover mechanism |
|---|---|---|---|---|
| 1 | `last_move_was_autonomous` (system.rs:1438) | `ManualSet` changed-state edges (:2314), ManualPulse/Transient/Stop arms, jump release (:2105, :5652), `note_server_authored_motion` (:1769, wire LOWER) | Interpreter seam `set_latch(bool)` — driven by `MovePlayer`→DoMotion/StopMotion (retail :317325/:317364 stamp) and jump release; `note_server_authored_motion` STAYS the only wire-side writer (both lanes) | `ManualSet` ingest arm short-circuits when `cmd_interp_enabled()` — key edges arrive as `KeyEdge`, never as `ManualSet`. The wire stamp is lane-independent (retail SmartBox::SetObjectMovement is outside the interpreter). |
| 2 | `pending_take_control` / `consume_pending_take_control` (system.rs:1443/:1789) | Set by every latch-raising edge arm; consumed in `tick` (:2578) | **SUPERSEDED**: ported `TakeControlFromServer` (interpreter inherent method) runs control-return + `StopInterpolating` + hold_run re-assert + FULL `ApplyCurrentMovement` three-head re-apply (FU-A tail) synchronously inside the dispatch that reclaimed control | Interp lane never sets `pending_take_control` (debug_assert it stays false while flag on). Seam methods `set_local_server_controlled(false)` + `stop_interpolating` reuse the same WorldState calls consume_pending_take_control makes today — no double-fire because the flag-on path never queues the pending bit. |
| 3 | `last_manual_drive` (system.rs:1480) — held-keys truth | `ManualSet` arm records every raw state (:2319); consumers: autorun restore (:1942), jump standstill root (:1986), slideCast held-axes capture (:5944), pursuit-end restore (:2910) | The three CommandLists ARE held-keys truth. Interp lane keeps `last_manual_drive` as a **derived snapshot**: the interpreter exposes `held_axes_snapshot()` (heads of the three lists → MotionState) and the wasm KeyEdge arm mirrors it into `last_manual_drive` after each edge | Consumers keep reading `last_manual_drive` unchanged (single code path, no per-consumer branch); the interp lane makes the interpreter the only WRITER of that mirror. No second copy drifts because the mirror is recomputed from list heads on every edge. |
| 4 | `merge_manual_edge` + `interpreted_drive_state` (system.rs:1877/:1810) | `ManualSet` arm composes effective drive per-axis (castMove Fix A) | Interpreter per-axis `DoMotion`/`StopMotion` dispatch REPLACES the merge: each dispatched motion applies one axis to the drive state via the seam (`do_motion`/`stop_motion` → drive-state application). `merge_manual_edge` is never called flag-on | Explicit consumption seam: interpreter seam calls land in a `QueuedDriveCommand`-equivalent single-axis apply; `ManualSet` unreachable flag-on (KeyEdge is the only input). |
| 5 | `?slideCast` `persist_held_manual_axes` (movement_manager.rs:509, called system.rs:5977) | Held axes sourced from `last_manual_drive` (:5944) | Same call site, same function — but held axes sourced from the interpreter's list-head snapshot (row 3's mirror keeps `last_manual_drive` correct, so the SOURCE LINE is unchanged; the WRITER of that source changed) | Works in BOTH lanes by construction (row 3). No code change at :5944 needed beyond the row-3 mirror. |
| 6 | A14-I2 pursuit (`wasmPursuit` cancel/restore, `local_pursuit_engaged`, `pending_pursuit_commands`) | `ManualSet` non-idle → cancel; idle-while-pursuit → no stomp; pursuit end → restore `last_manual_drive` | Interpreter `MovePlayer` → seam `cancel_moveto(0x36)` on autonomous DoMotion (retail apply_raw_movement → cancel_moveto :317421); restore path reads row-3 mirror | Wave-1: pursuit commands still arrive via their own JS calls (NOT keyboard) — unchanged in both lanes. The interp lane's cancel flows through the SAME `manual_moveto_cancel_pending` flag (single consumer in tick). |
| 7 | A14-I3 autorun overlay (`auto_run`, system.rs:1509, `set_auto_run` :1937) | wasm `setAutoRun` bridge under `?retailRunKeys=on` → `MovementSystem::set_auto_run` | Interpreter OWNS `auto_run` (P06 `SetAutoRun`/`ToggleAutoRun` — retail keeps it in CommandInterpreter, acclient.h:35349). The 0x090000C7 toggle arrives as a KeyEdge/on_action | Flag-on: `MovementSystem::set_auto_run` forwards into the interpreter (one writer: interpreter field); `MovementSystem.auto_run` becomes a read-mirror updated from the interpreter after each edge (same mirror pattern as row 3). Flag-off: untouched. |
| 8 | `jump_charge.rs` (JumpChargeClock, system.rs:1450) | wasm `jumpChargeCommence`/`executeJumpRelease`/`jumpChargeAbort` bridges | P09/P13 `CommenceJump`/`DoJump` WRAP the existing machinery: interpreter's OnAction case-8 routes press→`jump_charge_commence`, release→`execute_jump_release` via seam calls; `FinishJump` (slot 20, M6) → charge-abort | Zero new clocks; the interpreter never re-implements charge math. Wave-1 keeps the JS spacebar calls pointing at the SAME wasm exports in both lanes (the exports call into the one clock); flag-on the interpreter path is additive-dark until JS forwards space as an action id (Step 4+). |
| 9 | A13 send builders (`common.rs` build_move_to_state :157 / build_autonomous_position :173 / build_jump :204) | `tick` emits on motion-state edges + heartbeats; raw state built by `build_motion_state_raw_motion_state` (:311) from the JS tristate | P09's Send* wall maps onto the SAME builders (zero new send sites): `SendMoveToStateEvent` → build_move_to_state fed by **M1 converter** (interpreter's live `RawState` → wire `RawMotionState`), `SendAutonomousPositionEvent` → build_autonomous_position, TurnToEvent 0xF649 stays NO-GO (ADJ-6) | Single funnel `Session::send_action` unchanged. Flag-on, motion-state-edge sends come from interpreter `SendMovementEvent` (slot 19); the tick's edge-detector send is suppressed for key-driven edges (one sender per edge). Heartbeat cadence (`ShouldSendPositionEvent`) stays with the existing tick in wave 1. |
| 10 | M1 converter (new, common.rs) | n/a (legacy builds wire state from MotionState tristate) | `raw_state::RawState → protocol RawMotionState` honoring F5-2/F5-1/F1-3 wire rules (walk-class cmd + HoldKey gait, unit speeds, real sidestep enum, turn collapsed to TurnRight±speed) | New function, tested AGAINST `build_motion_state_raw_motion_state` outputs for the axis lattice (property: same MotionState → byte-identical wire fields). |
| 11 | JS sig-diff reader (`__axisValue` + sig-diff, index.html:8624-8668) | Reads keyState → `setMovementInput` on sig change | **Silenced**: under `?cmdInterp=on` the keydown/keyup handlers forward raw edges (input-action ids) to wasm `on_action`; the sig-diff dispatcher does not run (no `setMovementInput` for movement keys) | One `cmdInterpOn` gate in index.html around the sig-diff dispatch + the key handlers' forwarding branch. Movement DECISION (axis resolution, last-pressed-wins) moves into the interpreter's lists. |
| 12 | W3.1 local forward `setMotion` prediction + `CAST_MOVE_ON` anim-break cut + `lastForwardAxis` (index.html:8670-8735) | Fires off sig change; anim-break on forward-axis press mid-cast | Becomes a CONSUMER of interpreter events: wave-1 dark-lane keeps it fed from the same sig-change block but gated OFF under `?cmdInterp=on` (renderer reactions to interpreter events are Step-5 scope; wave-1 the interp lane is a correctness lane, not an eye-candy lane) | JS gate. The interpreter emits `InterpEvent::ForwardSlotEvicted` etc. in its effect stream (plumbed but unconsumed in wave 1, PENDING eye-test). |
| 13 | `setSidestepLayer` (index.html:8768+) | Sig-change side effect | Same as row 12: gated off under `?cmdInterp=on` in wave 1 (renderer overlay decisions become interpreter-event consumers at Step 5) | JS gate. |
| 14 | `__inputFunnelOn` / InputController (index.html:1371-1389, :8657) | Dedupes this dispatcher + camera dispatcher through one signature | Under `?cmdInterp=on` the funnel's movement dispatch is bypassed (camera-driven synthetic edges become synthetic on_action edges — ADJ-4 camera lane; wave 1: camera keeps legacy path only when flag off; flag on, camera movement dispatch is also silenced pending Step-5) | JS gate at the dispatch site. |

Non-conflicts (single-lane state, no handover needed): `motion_table_manager`,
`local_motion_interp` (the interpreter TALKS to it via seam like retail
CMotionInterp), `movement_managers` registry, sticky/moveto driver flags,
`server_controlled_projection` (wire-side), heartbeat state.

## Step ledger

- Step 0: must-fix edits applied at extraction time (packets are read-only
  source): ADJ-1 renames, ADJ-2 P07 vtable fixes, ADJ-3 P15 oracle terminal,
  SC-12 P04 set_auto_run signature, P12 invented-write drop, visibility pass.
- Step 1: P13 → motion_interp.rs/movement_manager.rs; P10 → move_to.rs(+nodes);
  P11 tests → move_to.rs test mod; P12 fold (WE_* consts, clear_target gate,
  _StopMotion contract note).
- Step 2: P01 list_engine.rs (renamed consts) + P02 stacks over P01 types.
- Step 3: command_interpreter.rs — P08 base struct + P02 lists + P05/P06
  fields; P03/P04/P05/P06/P07 inherent methods; ONE seam trait (SC-15 list);
  P09 folded (on_action/set_motion entry, Send* → seam); P15 fixtures dual-run.
- Step 4: `USE_COMMAND_INTERPRETER=false` + `?cmdInterp` runtime carrier; wasm
  `handleKeyEvent`/on_action export; JS forwarder; M1 converter; seam impl on
  MovementSystem; ownership rows 1-14 asserted.
- Stop rule: clean Step-2 stop beats messy Step-4.

## Regression floor (must hold at every commit)

core 432 pass / 10 known fails / 1 ignored · world 540/0 · web 124/+1 known ·
rust_pose 13/0. Flag-off behavioral floor: held-strafe slide continuous
through cast; strafe-tap lateral-only under held W; `?slideCast=off` dies at
first stomp.

## Session decisions log

Steps 0-4 EXECUTED 2026-07-03 (commits `d2384ba1`/`e218f95c`/`81ca17a2`/
`ef29882d`/`c374d34f`). The full decision record + step-5 work order lives in
`docs/HANDOFF-cmdinterp-wave1-landing-2026-07-03.md`. Headlines:

- Rows 1-6 + 9 implemented as specced; rows 7/8/12/13 deliberately deferred
  to step 5 (documented in `SystemInterpreterSeams`'s doc block, system.rs).
- Row 9 amendment: wave-1 keeps the TICK's edge-detector as the single
  sender in BOTH lanes (the seam's sends are deferred no-ops) — identical
  send cadence for the A/B; the M1 converter is landed + parity-proven and
  takes over at step 5.
- Row 2 amendment: `interp.controlled_by_server` is mirrored IN from
  `world.scene.local_server_controlled()` at each key edge (the wire-side
  grabs keep their legacy path until step 5); the FU-A tail clears the scene
  flag through the seam — no double-fire, asserted.
- The both-lanes-drive debug_assert lives in `tick` (KeyEdge + ManualSet in
  one queue drain).
