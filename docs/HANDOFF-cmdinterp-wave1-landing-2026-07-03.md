# HANDOFF — cmdInterp wave-1 LANDED (steps 0-4); next session = step 5 (2026-07-03)

Session 3 of the movement-port arc. Executed
`docs/PROMPT-cmdinterp-integration-2026-07-03.md` in full: the 16-packet Opus
fan-out is integrated behind **`?cmdInterp=on` (default OFF)**, five commits
on master, all pushed, every commit at the regression floor. Steps 0-4 of the
verdict's landing order are DONE; **step 5 (flag migration + send/use_time
ownership + the ONE batched 1070 A/B) is the next session's work order.**

## Commits (this session, oldest first)

| Commit | What |
|---|---|
| `d2384ba1` | Steps 0-1: leaf packets P10/P11-tests/P12-fold/P13 (+19 tests) + the PLAN doc with the 14-row ownership handover table |
| `e218f95c` | Step 2: P01 `list_engine.rs` (ADJ-1 names unflipped) + P02 `command_stacks.rs` (+27 tests, dark) |
| `81ca17a2` | Step 3: the unified `command_interpreter.rs` (M2) + P15 dual-run fixtures — **oracle AND real agree on all 29 strafecast pins** (+72 tests, dark) |
| `ef29882d` | Step 4: M1 converter (byte-parity proven) + KeyEdge lane + seam impl + wasm `handleKeyAction` + JS forwarder (default OFF) |
| `c374d34f` | Docs: `?cmdInterp` url-flags row, handoff session-3 section, M8 corrections (ADJ-5/ADJ-7/ADJ-9). NOTE: also swept in four OLDER untracked handoff docs (2026-06-21/22/29) that had been sitting in docs/ — legitimate records, kept. |

## Regression floor at HEAD (verified after every commit)

- `cargo test -p holtburger-core --lib` → **553 pass / 10 fail / 1 ignored**
  — the 10 are the SAME pre-existing list (all `client::movement::system::tests`;
  failing-set md5 fingerprint `693c4c01…` unchanged from the session-start
  baseline of 432/10/1).
- `-p holtburger-world --lib` → 540/0. `-p holtburger-web --lib` → **125/1**
  (124 + the new `cmd_interp_flag_defaults_off_unless_on`; the 1 =
  pre-existing `tests_substitution::triangulate_…`).
- `node tests/rust_pose.test.cjs` → 13/0 (it greps url-flags.md; the new
  `?cmdInterp` row did not disturb it).
- Flag-off behavioral floor (strafecast, session-2 live-validated) untouched:
  nothing constructs the interpreter, no KeyEdge is ever queued, the JS
  sig-diff lane is byte-identical.
- **pkg/ was NOT rebuilt this session** (no live test was run — the lane is
  dark). REBUILD BEFORE ANY LIVE TEST:
  `env PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build
  wasm-pack build --target web --out-dir pkg --release` from
  apps/holtburger-web. The JS forwarder typeof-guards
  `handle.handleKeyAction`, so a stale pkg degrades to a console warn, not a
  boot break.

## File map (everything this session added/touched, holtburger crate paths)

**New modules** (`crates/holtburger-core/src/client/movement/`):
- `command_interpreter.rs` — THE unified retail interpreter: P08 session
  struct (ctor seeds fidelity-verified) + P02 lists + P05/P06/P07 fields;
  P03-P08 bodies as inherent methods; P09 folded (on_action/set_motion entry,
  combat pre-hooks + Send* wall as seam calls); ONE `InterpreterSeams` trait
  (`&mut dyn`, passed as a separate param — the SC-15 re-entrancy resolution);
  `CmdStruct` (SC-9 unified shape); `MovementError`; the banked 91-pair
  `EMOTE_INPUT_ACTION_PAIRS` (M3, dark); 43 unit tests. Carries a
  **module-level `#![allow(dead_code)]`** whose note says exactly what is
  still dark — NARROW IT to per-item allows as step 5 wires the lifecycle/
  mouse/send surfaces.
- `retail_behavior_tests.rs` (`#[cfg(test)]` in mod.rs) — the P15 fixtures
  DUAL-RUN: `RefInterp` oracle (ADJ-3 terminal patch applied — the packet's
  HNFM-terminal was the SC-4 mis-resolution) + `RealFixture` (SC-20 harness:
  CmdStruct packing, `server_stomp` synthesizes the SetObjectMovement lane,
  recording `SinkSeams` applies the ApplyMotion axis-slot semantics
  :332759). A pin failing on ONE arm = the drift alarm firing.
- `list_engine.rs` (P01) — `CommandList`/`CommandLists`/`ListKind`/
  `which_list`/`apply_hold_keys_to_command`. Direction names are the RETAIL
  ones (0x0D=TurnRight — the fan-out had all four flipped, ADJ-1/SC-1).
- `command_stacks.rs` (P02) — the PINNED unit-level stacks port over P01's
  concrete types (SC-5: trait + dup which_list dropped). The unified
  interpreter transplants these bodies; this copy + its 17 tests stay as
  the second drift pin.
- `move_to_nodes.rs` (P10) — MoveToManager lifecycle/node primitives.

**Extended:**
- `motion_interp.rs` — P13 tails (`jump_v_z`, `max_speed`,
  `is_standing_still`, `jump_charge_is_allowed`, `jump_is_allowed` +
  `JumpAllowEnv`) + the consolidated wave-1 consts (`MOTION_JUMP` 0x2500003B,
  `MOTION_HOLD_RUN` 0x85000001, `MOTION_HOLD_SIDESTEP` 0x85000002,
  `MOTION_AUTORUN_TOGGLE` 0x090000C7 — ADJ-16's corrected literals) +
  `p13_tail_tests`.
- `movement_manager.rs` — `inq_interpreted_motion_state` /
  `inq_raw_motion_state` (the M1 state source, SC-17) / `handle_enter_world`
  no-op.
- `move_to.rs` — P10 seam-handle fields + accessors; the named `WE_*`
  WeenieError family (raw literals swapped at all production sites, incl.
  three `WE_ACTION_CANCELLED` sites in system.rs); the P12 `clear_target`
  gate on `MoveToDriveOutput` (data-only — no consumer until a persistent
  target-subscription lane exists); `p11_begin_tests` + `p12_fold_tests`.
- `params.rs` — `set_stop_completely` (P07/SC-11 fold).
- `common.rs` — **M1**: `build_raw_state_raw_motion_state` +
  `m1_converter_byte_parity_with_legacy_builder` (byte-identical to the
  legacy tristate builder across the full 54-state gait×fwd×side×turn
  lattice) + the Substate-omits/RunForward-collapses test.
- `system.rs` — `USE_COMMAND_INTERPRETER=false` + `cmd_interp_runtime` +
  `cmd_interp_enabled`/`set_cmd_interp`; `command_interpreter:
  Option<CommandInterpreter>` (Option = the borrow-split: moved OUT during
  dispatch); `QueuedDriveCommand::KeyEdge` + `enqueue_key_action`; the tick
  pre-pass (`ingest_key_edge` gets world; other commands keep the old path)
  + the **both-lanes-drive debug_assert** (KeyEdge + ManualSet in one tick);
  `interp_held_snapshot` (row-3 mirror); `SystemInterpreterSeams` at the
  BOTTOM of the file (after the impl, before `mod tests`) — read its doc
  block first, it enumerates every wave-1 scoping decision; the end-to-end
  lane test `cmd_interp_key_edges_drive_the_interpreter_lane` (press →
  pop-through → FU-C silent release → FU-A reclaim with leash drop, all
  through `tick`).
- `handle.rs` — `set_cmd_interp` + `enqueue_key_action`.
- `mod.rs` — module registrations.

**Web:**
- `apps/holtburger-web/src/lib.rs` — `parse_cmd_interp_flag` (default-OFF
  opt-in, `=on` only) + init-site call; `SessionCommand::KeyAction`;
  `handleKeyAction` wasm export; recv arm (same world/entity-seeded guards
  as SetMovementInput); parse test.
- `apps/holtburger-web/index.html` — `CMD_INTERP_ON`, `CMD_INTERP_ACTIONS`
  (w=0x29 s=0x2A d=0x2C a=0x2D e=0x2E q=0x2F shift=0x32),
  `__cmdInterpForward` (typeof-guarded); keydown forwards press EDGES
  (`!ev.repeat` — the held-key-never-refires invariant), keyup forwards
  releases UNCONDITIONALLY (FU-C is decided wasm-side); the sig-diff
  dispatcher gated `!CMD_INTERP_ON` — which also silences the W3.1 forward
  clip, the anim-break cut, and `setSidestepLayer` (rows 11-13).
- `apps/holtburger-web/scene3d/camera.js` — module-level `CMD_INTERP_ON` +
  the dispatch gate (row 14: a camera-relative setMovementInput would
  double-drive; the sig still advances so rig side-effects keep edge
  semantics).

## Step-5 work order (the verdict's next stage — nothing here is started)

1. **Flag migration** (verdict §3.3): `?castMove` → `honor_autonomy_latch`,
   `?slideCast` → `slidecast_persist` as INTERPRETER configs with the URL
   flags as aliases. The legacy carriers + `merge_manual_edge` + the JS
   sig-diff stay as the `?cmdInterp=off` arm (deletion is a post-flip
   cleanup wave, NOT step 5).
2. **Send ownership flip** (row 9): the seam's `send_move_to_state` goes
   live and the tick's edge-detector send is suppressed for key-driven
   edges. DESIGN DECISION TO MAKE FIRST: the interpreter lane does not yet
   maintain a `RawState` — the seam composes a `MotionState` scratch. Two
   options: (a) drive the local minterp's `raw_state` through the lattice
   (seam `do_motion` → `RawState::apply_motion_u32`, then M1 reads
   `inq_raw_motion_state` — the retail shape, SC-17); (b) cheap bridge:
   `RawState::from_motion_state(drive)` → M1 (byte-equivalent for the
   keyboard alphabet by the parity property). (a) is the retail-faithful
   endpoint; (b) is a safe intermediate. Sends are async
   (`Session::send_action`) and seams are sync — queue the built pack from
   the seam and flush it in the tick's async body (the pattern the existing
   pulse sends use).
3. **use_time pump**: call `interp.use_time(seams)` from the tick while
   flag-on — brings the UseTime FU-A trigger (queued input under server
   control reclaims without a fresh edge) and the position-event gate.
   Decide heartbeat ownership (interpreter `ShouldSendPositionEvent` vs the
   tick's existing heartbeat — ONE sender; the seam's position reads are
   currently benign stubs, see `SystemInterpreterSeams` doc).
4. **Jump lane** (row 8/M6): JS forwards space as action 0x31 under the
   flag; seam `commence_jump`/`do_jump` route onto the EXISTING
   `jump_charge_commence`/`execute_jump_release`; `finish_jump` →
   charge-abort. NOTE the seam currently has `world` but NOT `now` — add it
   to the struct when wiring (tick has it).
5. **Renderer events** (rows 12-13): give the interpreter an effect/event
   stream (e.g. `ForwardSlotEvicted`) the wasm surfaces to JS so the
   anim-break cut + sidestep overlay return as CONSUMERS under the flag
   (flag-on currently has NO local cast-cut visual — a known, documented
   gap; fine for protocol bots, not for the eye-test).
6. **Wasm --release rebuild**, then the **ONE batched 1070 live-bot A/B**
   (recipe in the url-flags `?cmdInterp` row): bare regression arm /
   `?cmdInterp=on` / `?cmdInterp=on&slideCast=off` burst arm + the P15
   sequence-A/B/F key scripts replayed live (ADJ-15 Q3: does a turn-tap
   reclaim visually evict the gesture? Q5: real cast-gesture ids). Session-2
   bot lore applies (ghost-wait 95-100s AFTER dropping, continuous
   evaluates, `<account>/+Tester2` = `autoSpawn=%2BTester2`, drudges parked at
   the academy).
7. **Default flip = its own commit AFTER the A/B** (house default-ON bar).
8. Cleanups riding along: ADJ-10 (refactor `execute_jump_release` onto
   `MotionInterp::jump_is_allowed` — one owner; the two sites are currently
   pinned together by `p13_tail_tests`); narrow the module-level allow in
   command_interpreter.rs; M7 (ui_toggles_run constant-true → player-options
   store when one exists).

## Session decisions + traps the next agent should not re-hit

- **ADJ-9 was already satisfied**: `use_time_moveto` →
  `apply_moveto_lattice` already feeds `_DoMotion` refusals back as
  `cancel_moveto(err)` SAME-tick. No new plumbing was added for it.
- **P12's `clear_target`** is NOT the sticky unstick — retail
  `CPhysicsObj::clear_target` is the TargetManager unsubscribe; our per-tick
  `MoveToView::target_pos` refresh has no subscription, so the output field
  is documented data with no consumer. Do not wire it to
  `unstick_local_player`.
- **Packet test fixtures had real bugs** (all fixed at adoption): P01's
  was-head test removed the head first, PROMOTING the next element (needs 3
  elements); P11's `out.completion` asserts had to become latch-side
  (`take_completion()`) — the landed code mirrors the latch into `out` only
  at the `use_time` boundary and inside `cancel_moveto`, not in the private
  bodies; P11's stall test needed stamps pinned to the exact
  cylinder-metric distance (the raw 50.0 seed reads as ~0.27 m/s of false
  progress via the self-radius).
- **The interpreter's `controlled_by_server` is mirrored IN from
  `world.scene.local_server_controlled()` at every key edge** (the wire-side
  grabs don't call `interp.lose_control_to_server` until step 5); the FU-A
  leash drop clears the scene flag through the seam. Keep this sync in mind
  when migrating the wire side.
- **`capped-build` drops `~/.cargo/bin`** — every cargo/wasm-pack invocation
  needs the `env PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"`
  prefix (the bare form fails with "ionice: failed to execute cargo").
- The failing-set fingerprint trick:
  `cargo test -p holtburger-core --lib 2>&1 | rg '^    client' | sort | md5sum`
  → `693c4c01…` = the known 10. Any other hash = a real regression.
- The quality-pass artifacts live at `~/from-vm/wave1/` (LAPTOP-LOCAL, not
  in git): `QUALITY-integration.md` (SC-1..21, ADJ-1..16, M1..M8) +
  `QUALITY-fidelity.md` (the verified flat-slot vtable table) +
  `parts/p01..p16.md`. The verdict + spec + PROMPT + PLAN are in docs/.

## Open questions carried forward (from the quality pass, still open)

- ADJ-15 Q3 (turn-tap visual eviction) + Q5 (real gesture ids) — 1070/live
  observations, step 6 above.
- P13 OQ-3 (charge-time 73/72 gate parity) — DESIGN.md's skip stands until a
  golden replay says otherwise.
- M3 emote InputAction numeric ids (the 91-pair list is banked in
  command_interpreter.rs; needs an id source).
- M4 mouse-look (`use_mouse_turning` false; the whole MovePlayer remap block
  + P07 handlers are ported and unit-tested but unreachable).
- The caster-era drift question (ADJ-5): no second-era binary exists on this
  box — the "2013" dump is the same binary as acclient.c.
