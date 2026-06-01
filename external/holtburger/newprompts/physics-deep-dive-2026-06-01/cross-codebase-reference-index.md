# Cross-Codebase File:Line Reference Index — Movement Physics

A lookup table of every load-bearing source location surfaced (and verified) during the investigation. Use it to jump straight to the code instead of re-searching.

**Roots:**
- `OURS` = `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger`
- `ACE`  = `/home/wbterminal/WorldBuilder-ACME-Edition/external/ACE/Source/ACE.Server/Physics` (+ `ACE.Server/WorldObjects` for Player_*)
- `DECOMP` = `/home/wbterminal/ac-headers/acclient.c` (+ `.h` structs, `.txt` cvdump)

> Line numbers were accurate at investigation time (2026-06-01, OURS branch `fix/holtburger-stutter-streaming`). Re-grep if the tree has moved. ⚠ = a citation the adversarial pass found slightly off (corrected location given).

---

## OURS — Rust authoritative integrator

| Topic | File | Lines | Notes |
|---|---|---|---|
| Per-frame `dt` computation (raw, unclamped) | `crates/holtburger-core/src/client/movement/handle.rs` | 96-122 | `now.saturating_duration_since(prev)`, 16ms fallback first tick only |
| `Instant::now()` passed as `now` | `crates/holtburger-core/src/client/commands.rs` | 1977 | source of the raw rAF delta |
| Main local-drive integrator | `crates/holtburger-core/src/client/movement/system.rs` | 597-721 | `advance_local_pose_for_manual_drive` |
| Friction decay + accel cap + snap (grounded) | `crates/holtburger-core/src/client/movement/system.rs` | 677-708 | `(1-F)^dt` @677; accel cap @684-692; snap gate @705 |
| Gravity step (airborne) | `crates/holtburger-core/src/client/movement/system.rs` | 936-939 | `vz -= 9.8*dt; z += vz*dt` (symplectic Euler) |
| Raw delta build | `crates/holtburger-core/src/client/movement/system.rs` | 717-721 | `velocity * dt_s` |
| Indoor-unbaked freeze | `crates/holtburger-core/src/client/movement/system.rs` | 746-752, 1022-1026 | lateral frozen to zero, Z-snap skipped |
| Indoor AABB floor pop | `crates/holtburger-core/src/client/movement/system.rs` | 1031-1034 | `cell_aabb.min.z + 0.005` fallback |
| Heartbeat Z terrain snap | `crates/holtburger-core/src/client/movement/system.rs` | 1419-1435 | before write-back |
| Friction/accel/snap constants | `crates/holtburger-core/src/client/movement/common.rs` | 374, 405, 382, 417 | `FRICTION=0.5`, `ACCEL_CAP=8.0`, `SNAP=0.25`, `SIDESTEP_CAP=3.0` |
| `FALLBACK_RUN_RATE_SCALAR=4.5` | `crates/holtburger-core/src/client/movement/common.rs` | 21 | also used at 147 `player_run_rate().unwrap_or(4.5)` |
| `forward_command_for_state` (walk→run swap) | `crates/holtburger-core/src/client/movement/common.rs` | 178-184 | `RUN_FORWARD 0x44000007` / `WALK_FORWARD 0x45000005` |
| `forward_axis_speed` (⚠ backstep bug) | `crates/holtburger-core/src/client/movement/common.rs` | 439-446 | (Run,Backstep) returns bare `run_rate_scalar` |
| `sidestep_axis_speed` (±3 cap) | `crates/holtburger-core/src/client/movement/common.rs` | 448-455 | |
| `local_velocity_for_state` (diagonal sum) | `crates/holtburger-core/src/client/movement/common.rs` | 466-511 | geometric forward+sidestep |
| Speed resolvers (MotionTable-derived) | `crates/holtburger-world/src/state/self_movement.rs` | 36-66 | `base_walk/run_forward_velocity.length() * run_rate_scalar` |
| `run_rate_from_skill_and_burden` (GetRunRate port) | `crates/holtburger-world/src/state/self_movement.rs` | (grep `run_rate_from_skill`) | 4.5 @ skill≥800 |
| MotionTable resolution | `crates/holtburger-world/src/state/motion_resolution.rs` | — | resolves base velocities at runtime |
| Collision sweeps | `crates/holtburger-world/src/spatial/physics.rs` | 64 (`inflate`), 205-255 (`clamp_delta_to_cell_interior`), 313-511 (cell walls), 1116-1118 (`advance_body_kinematics`) | AABB + triangle + cylinder, no BSP |
| Entity collision (2D, Z ignored) | `crates/holtburger-world/src/spatial/entity_collision.rs` | 27-29 (BSP fallthrough), 44-60 (Z ignored), 102-104 (TODO) | |
| Jump velocity / burden | `crates/holtburger-world/src/player/types.rs` | 715 (`compute_jump_velocity_z`), 643-650 (`compute_fall_damage` doc-only), 738 (`begin_jump` sets JUMP) | |
| Setup.dat step heights (parsed, ignored) | `crates/holtburger-world/.../setup_model.rs` | (grep `step_up`/`StepUpHeight`) | data read, never fed to solver |
| EDGE_SLIDE parse (unused) | `crates/holtburger-world/.../object.rs`, `hydration.rs` | 78; 286-287 | `PhysicsState::EDGE_SLIDE 0x00400000` → `AllowEdgeSlide` |
| Force-position Snapshot mode | `crates/holtburger-world/.../state/mutations.rs` | 606 (`set_player_position`), 254 (`apply_forced_reposition_reset`) | |
| Authoritative body reconcile | `crates/holtburger-world/.../spatial/scene.rs` | 1230-1246 (preserve), 1243 (idle hard-set), 1244 (remote Reset) | |
| Position veto helper | `crates/holtburger-world/.../player/mutations.rs` | 246 (`apply_position_from_server`) | |

## OURS — JS / wasm-web client

| Topic | File | Lines | Notes |
|---|---|---|---|
| JS predictor advance (X/Y only) | `apps/holtburger-web/scene3d/camera.js` | 1060-1069 | `_advancePrediction` |
| JS reconcile (snap/lerp) | `apps/holtburger-web/scene3d/camera.js` | 881, 904-911 (>5m snap), 907, 918-921, 1128 | `_reconcilePrediction` / `_applyPredictionLerp` |
| Lerp duration / fallback consts | `apps/holtburger-web/scene3d/camera.js` | 378 (`_lerpDurationMs=150`), 944-946, 1008-1024 | `?? 4.5 / ?? 1.0` defensive fallbacks |
| Axis composite (X/Y from JS, Z/heading from wasm) | `apps/holtburger-web/scene3d/loop.js` | 260-285 | `applyLocalPlayerPoseFromIntegrator`; `getTerrainVisualZ` @285 |
| 2D-path predictor + dt clamp | `apps/holtburger-web/index.html` | 10013 (`Math.min(dt,0.1)`), 5924-5976 (local no-lerp), 5960-5968 (landblock-crossing snap), 7635 (4.5 default), 9969 (tickMovement invoke) | |
| `get/set_last_client_prediction` (diag shadow) | `apps/holtburger-web/index.html` | 22196-22278 | getter 22224-22237, setter 22258-22278 |
| Dead-code wasm speed path | `apps/holtburger-web/src/lib.rs` | 25462 (`build_raw_motion_state_for_input`, `#[allow(dead_code)]`) | RUN_SPEED=4.5 |
| Falling/Fallen emission | `apps/holtburger-web/src/lib.rs` | (grep `0x40000015`/`0x40000008`) | client visual state machine |

## ACE — readable retail port

| Topic | File | Lines |
|---|---|---|
| Constants: Gravity/Quantums/MaxVelocity/Friction/FloorZ | `PhysicsGlobals.cs` | 13, 15, 30, 34, 38-43, 48, 50, 58 (`DefaultStepHeight=0.01`) |
| `update_object` (subdivide/skip loop) | `PhysicsObj.cs` | 4140-4190 (TickRate gate 4140; while-subdivide 4175-4180; HugeQuantum 4169-4173; MinQuantum remainder 4182) |
| `UpdatePhysicsInternal` (2nd-order integrate + clamp + friction) | `PhysicsObj.cs` | 1832-1860 (movement 1854-1858, clamp 1843-1846) |
| `UpdatePositionInternal` (calls the above; AFrame.Combine) | `PhysicsObj.cs` | 1862-1881 |
| `calc_acceleration` (gravity → Acceleration.z) | `PhysicsObj.cs` | 2079-2080 |
| `calc_friction` (contact-plane proj + sledding) | `PhysicsObj.cs` | 2120-2141 (early-out 2124-2127; sledding 2132-2136) |
| `set_on_walkable` (Contact + Normal.Z≥FloorZ) | `PhysicsObj.cs` | 1234 |
| Anim speed constants | `Animation/MotionInterp.cs` | 27-32 (Run=4.0, Walk=3.1199999, Sidestep=1.25, MaxSidestep=3.0, BackwardsFactor) |
| `get_state_velocity` (jump-launch only) | `Animation/MotionInterp.cs` | 678-700 |
| `get_leave_ground_velocity` (sole caller) | `Animation/MotionInterp.cs` | 200, 656 |
| `apply_run_to_command` (run-scale, sidestep clamp) | `Animation/MotionInterp.cs` | 394-428, 543, 550-560 |
| `get_max_speed` / `adjust_motion` (clamps) | `Animation/MotionInterp.cs` | 421, 675 |
| `get_jump_v_z` / jump | `Animation/MotionInterp.cs` | 634-652 |
| `GetJumpHeight` / `GetRunRate` | `Animation/MovementSystem.cs` | (GetJumpHeight ~12; GetRunRate 20-28) |
| `InqJumpVelocity` (`√(h·19.6)`) | `Common/WeenieObject.cs` | 73-98 (GetJumpHeight @93, sqrt @95) |
| `GetBurdenMod` | `Common/EncumbranceSystem.cs` | — |
| Step heights (Setup.dat × Scale.Z) | `Common/PartArray.cs` | 240-247 |
| Transition: CalcNumSteps / StepUp / EdgeSlide gate | `Transition.cs` | 130-139 (CalcNumSteps), 270 (EdgeSlide+OnWalkable gate), 754/850 (StepUp 0.039999999 fallback) |
| Sphere slide / collide | `Common/Sphere.cs` | 624 |
| Fall damage | `../WorldObjects/Player_Move.cs` | 254-271 (formula), 282-309 (TakeDamage_Falling) |
| Server force-position / validate | `../WorldObjects/Player_Tick.cs` | 403 (`MoveToState_UpdatePosition_Threshold=1s`), 411-491 (UpdatePlayerPosition), 513 |
| `SetRequestedLocation` | `../WorldObjects/Player_Networking.cs` | 300 |
| `TimeBetweenPositionEvents` (1.875, dead code) | `../WorldObjects/.../CommandInterpreter.cs` | 32, 793 (`return true` stub) |
| Interpolation/Sticky max-speed clamps | `InterpolationManager.cs`, `StickyManager.cs` | 221, 112 |

## DECOMP — retail acclient.c (cross-checked)

| Topic | Line(s) |
|---|---|
| `UpdatePhysicsInternal` half-step integrate | 317756-317774 |
| `calc_friction` | (search `calc_friction`) |
| `MovementSystem::GetJumpHeight` | ~713823 |
| `get_jump_v_z` | ~343343 |
| `apply_run_to_command` (run-scale @343466; sidestep clamp @343474-343480; walk→run rewrite) | 343463-343506 |
| `get_state_velocity` magnitude clamp (4×run_factor) | 343586-343593 |
| `get_leave_ground_velocity` call site | ~343821 |
| `InterpretedMotionState` forward+sidestep slots | 332759-332786 |
| `SmartBox::HandleReceivedPosition` (gating; set_velocity 0 @145203-145206; ConstrainTo @145199-145201; inner newer_event @145167/145196) | 144717-145227 |
| `InterpolateTo` / `ConstrainTo` (PositionManager) | 388317 / 388367; InterpolationManager 389055-389057 |
| Gravity constant `-9.8000002` | 45824 |
| MAX_INTERPOLATED_VELOCITY 7.5 | 41536 |

## Repos with NO physics simulation (data/protocol only)
- **DatReaderWriter** (`external/DatReaderWriter`): MotionTable/Setup parsing. `DatReaderWriter.Tests/DBObjs/MotionTableTests.cs` shows `MotionData.Velocity` (animation-driven movement field).
- **Chorizite** (`external/chorizite`): native client hooks + ACProtocol marshaling. `Chorizite.NativeClientBootstrapper/AcClient/Movement.cs` wraps native `CMotionInterp*`/`MoveToManager*` — physics is native C++, not reimplemented.
- **melt** (`external/melt`): research-only DAT enums (`AnimationHookType`, `MovementCommand`, `PhysicsState`).

## Useful audit scripts (in OURS)
- `jump_clip_data_check.rs` — audits all 436 motion tables for the Jump `0x003B` clip (returns FAIL on real DAT: 0 hits).
- physics-replay capture/validate (`capture_physics_replay.cjs` / `validate_physics_replay.cjs`, `--subject={prediction,pose}`) — Wave 3.A/3.F drift harness.
- `test_ac_locomotion_per_stance.mjs`, `test_ac_locomotion_dispatch.mjs` — locomotion dispatch coverage.
