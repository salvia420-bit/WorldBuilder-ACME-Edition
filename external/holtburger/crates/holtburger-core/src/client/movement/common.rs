use crate::client::movement_types::{
    ForwardLocomotion, Gait, MotionState, MotionStyle, MovementPacketMetadata, SidestepLocomotion,
    Turn, planar_velocity_for_heading,
};
use holtburger_common::{Guid, Vector3};
use holtburger_protocol::messages::game_action::*;
use holtburger_protocol::messages::game_message::{RawMotionFlags, RawMotionState};
use holtburger_protocol::messages::*;
use holtburger_world::context::WorldContextExt;
use holtburger_world::{SelfMovementCapabilities, WorldState};
use std::f32::consts::{PI, TAU};
use std::time::Duration;

// ACE's movement packets carry a run-rate / speed scalar, not a standalone
// "already world-space" speed constant divorced from animation. In the retail
// math that scalar is applied against the run animation base speed, and after
// the engine's unit conversion it ends up numerically matching our meters/sec
// representation. That coincidence is useful, but it is also the trap: this
// value is the *maximum* run speed for a fully capped player, not the speed
// every character should emit or simulate.
const FALLBACK_RUN_RATE_SCALAR: f32 = 4.5;
pub(super) const AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
pub(super) const WALK_FORWARD_MOTION_COMMAND: u32 = 0x4500_0005;
const WALK_BACKWARD_MOTION_COMMAND: u32 = 0x4500_0006;
// Wave 2 Phase 2.3 (2026-05-26): `RunForward (0x44000007)` is the
// motion code retail emits in `InterpretedState.ForwardCommand`
// after `apply_run_to_command` swaps `WalkForward` when speed>0
// AND HoldKey=Run (`~/ac-headers/acclient.c:343463-343467` and
// `external/ACE/Source/ACE.Server/Physics/Animation/MotionInterp.cs:539-544`).
// ACE accepts it on the wire too: `adjust_motion`
// (`MotionInterp.cs:401-402`) handles `MotionCommand.RunForward`
// as a no-op return (no canonicalization needed), and the
// `RawMotionState.ApplyMotion` reject-RunForward branch
// (`RawMotionState.cs:69`) only fires when the server itself is
// constructing a RawState — not on wire deserialization (which
// uses `SetState` at `:117-140` with no filtering). Sending it
// directly causes the renderer to play the run clip via
// `entities.js`'s `CMD_LOW_RUN_FORWARD = 0x0007` classifier
// (`scene3d/entities.js:131,325`), bypassing the implicit-swap
// dependency on ACE's broadcast canonicalization.
pub(super) const RUN_FORWARD_MOTION_COMMAND: u32 = 0x4400_0007;
pub(super) const TURN_RIGHT_MOTION_COMMAND: u32 = 0x6500_000d;
// Phase 2.5 (2026-05-26): `TurnLeft (0x6500000E)` and `SideStepLeft
// (0x65000010)` MotionCommand enum values exist on the AC wire schema
// (`external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:20-23`), but we
// NEVER emit them on outbound packets — retail's
// `InterpretedMotionState::ApplyMotion` (`~/ac-headers/acclient.c:332761-
// 332786`) only carries `TurnRight` / `SideStepRight`, and ACE's
// `MotionInterp.adjust_motion` (`external/ACE/Source/ACE.Server/Physics/
// Animation/MotionInterp.cs:409-417`) rewrites the Left codes to Right
// with negated speed. Player MT 0x09000001 has no
// `cycles[(stance, TurnLeft|SideStepLeft)]` entries, so the renderer's
// cache lookup for the Left codes returns null and the rig silently
// no-ops. See `sidestep_command_for_state` / `turn_motion_command_for_state`
// below for the Phase 2.5 collapse logic.
const SIDESTEP_RIGHT_MOTION_COMMAND: u32 = 0x6500_000f;
pub(super) const RUN_HELD_TURN_SPEED_RAD_PER_SEC: f32 = 1.5;
const NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC: f32 = 1.0;

pub(super) fn signed_heading_delta(current_heading: f32, desired_heading: f32) -> f32 {
    let mut delta = (desired_heading - current_heading) % TAU;
    if delta <= -PI {
        delta += TAU;
    } else if delta > PI {
        delta -= TAU;
    }
    delta
}

pub(super) fn normalize_heading(heading: f32) -> f32 {
    heading.rem_euclid(TAU)
}

pub(super) fn raw_motion_state_with_motion_style(
    world: &WorldState,
    mut raw_motion_state: RawMotionState,
    motion_style: MotionStyle,
) -> RawMotionState {
    match motion_style {
        MotionStyle::PreserveServer => {
            if let Some(current_style) = world.player.last_server_motion_style {
                raw_motion_state.set_current_stance(current_style);
            }
        }
        MotionStyle::Explicit(current_style) => {
            raw_motion_state.set_current_stance(current_style);
        }
        MotionStyle::Omit => {
            raw_motion_state.flags.remove(RawMotionFlags::CURRENT_STYLE);
            raw_motion_state.current_style = None;
        }
    }

    raw_motion_state
}

fn resolve_contact(world: &WorldState, metadata: MovementPacketMetadata) -> bool {
    metadata
        .contact
        .or(world.player.last_server_grounded)
        .unwrap_or(true)
}

pub(super) fn encode_contact_long_jump(world: &WorldState, metadata: MovementPacketMetadata) -> u8 {
    u8::from(resolve_contact(world, metadata))
}

fn encode_last_contact(world: &WorldState, metadata: MovementPacketMetadata) -> u8 {
    u8::from(resolve_contact(world, metadata))
}

pub(super) fn has_autonomous_position_sync_target(world: &WorldState) -> bool {
    let Some(position) = world.local_player_runtime_pose() else {
        return false;
    };

    world.player.guid != Guid::NULL && position.landblock_id != Guid::NULL
}

pub(super) fn build_autonomous_position(
    world: &WorldState,
    metadata: MovementPacketMetadata,
) -> Option<AutonomousPositionActionData> {
    let position = world.local_player_runtime_pose()?;
    if world.player.guid == Guid::NULL || position.landblock_id == Guid::NULL {
        return None;
    }

    Some(AutonomousPositionActionData {
        position,
        instance_sequence: world.player.instance_sequence,
        server_control_sequence: world.player.server_control_sequence,
        teleport_sequence: world.player.teleport_sequence,
        force_position_sequence: world.player.force_position_sequence,
        last_contact: encode_last_contact(world, metadata),
    })
}

fn hold_key_for_motion_state(state: MotionState) -> HoldKey {
    match state.gait {
        Gait::Run => HoldKey::Run,
        Gait::Walk => HoldKey::None,
    }
}

pub(super) fn player_run_rate_scalar(world: &WorldState) -> f32 {
    world.player_run_rate().unwrap_or(FALLBACK_RUN_RATE_SCALAR)
}

/// Wave 2 Phase 2.3 (2026-05-26): the motion code itself must
/// change Walk → Run when the player is forward+shift, not just
/// the speed scalar. Retail's `CMotionInterp::apply_run_to_command`
/// (`~/ac-headers/acclient.c:343463-343467`) swaps `WalkForward
/// (0x45000005)` to `RunForward (0x44000007)` when speed > 0 and
/// HoldKey=Run, then multiplies speed by `run_factor`. The
/// motion-table fetches the RUN cycle (longer stride, faster arm
/// swing) on the resulting motion code, not a sped-up walk clip.
///
/// Pre-Wave-2 we emitted `WALK_FORWARD_MOTION_COMMAND` with a
/// scaled speed for both gaits, relying on ACE's server-side
/// canonicalization to broadcast `RunForward` back to clients. That
/// works for the renderer (entities.js's classifier sees
/// `RunForward` in the broadcast and picks the run clip), but it
/// muddies the client→server wire: ACE has to re-derive the run
/// state, and `__diag.motion.snapshot()` on the local player shows
/// the wrong cmd until the round-trip closes.
///
/// Backstep keeps its walk-class motion code regardless of gait
/// (no `RunBackward` enum entry exists; see
/// `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:13-23`).
/// Speed scaling for backstep is handled at the local-prediction
/// layer (`local_locomotion_speed_for_state`) per Phase 2.1; on the
/// wire it stays at 1.0 because ACE's `adjust_motion` +
/// `apply_run_to_command` re-applies the scaling server-side.
fn forward_command_for_state(
    forward: ForwardLocomotion,
    gait: Gait,
    run_rate_scalar: f32,
) -> (u32, f32) {
    match (gait, forward) {
        (Gait::Run, ForwardLocomotion::Forward) => (RUN_FORWARD_MOTION_COMMAND, run_rate_scalar),
        (Gait::Walk, ForwardLocomotion::Forward) => (WALK_FORWARD_MOTION_COMMAND, 1.0),
        (_, ForwardLocomotion::Backstep) => (WALK_BACKWARD_MOTION_COMMAND, 1.0),
    }
}

/// Wave 2 Phase 2.2 (2026-05-26): sidestep wire encoding. No `RunSideStep*`
/// enum entries exist (`external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:22-23`),
/// so retail handles "shift+strafe" via speed scaling on the existing motion
/// codes. Speed on the wire stays at 1.0; server-side `apply_run_to_command`
/// re-applies the scaling (and clamps at ±3.0 m/s).
///
/// Wave 2 Phase 2.5 (2026-05-26): collapse `SideStepLeft (0x65000010)` into
/// `SideStepRight (0x6500000F)` with NEGATED speed. Retail's
/// `InterpretedMotionState::ApplyMotion` does NOT carry a separate Left code
/// (`~/ac-headers/acclient.c:332766-332770` — only `SideStepRight` is
/// handled), and retail's `CMotionInterp::apply_run_to_command` operates on a
/// signed speed for `0x6500000F` (`acclient.c:343471-343481` — the clamp uses
/// `fabs(v6) > 3.0` and preserves the sign of `v6`). ACE mirrors this at
/// `MotionInterp.adjust_motion` (`external/ACE/Source/ACE.Server/Physics/
/// Animation/MotionInterp.cs:414-417`) — `SideStepLeft` is auto-rewritten to
/// `SideStepRight` with `speed *= -1`. The player MotionTable (DID 0x09000001)
/// does NOT contain a `cycles[(stance, SideStepLeft)]` entry for any of the
/// 13 stances — only the Right cycle exists, so the renderer's cache lookup
/// for the Left code returns a null clip and silently no-ops.
///
/// Returns `(motion_command, speed_sign)`. The caller multiplies the
/// resolved base speed by this sign to produce the signed wire-side speed.
fn sidestep_command_for_state(sidestep: SidestepLocomotion) -> (u32, f32) {
    match sidestep {
        // Negated speed signals "go left" to the local integrator,
        // remote observers, and ACE's `adjust_motion` (which would
        // otherwise have to do the Left → Right rewrite itself).
        SidestepLocomotion::StrafeLeft => (SIDESTEP_RIGHT_MOTION_COMMAND, -1.0),
        SidestepLocomotion::StrafeRight => (SIDESTEP_RIGHT_MOTION_COMMAND, 1.0),
    }
}

/// Wave 2 Phase 2.5 (2026-05-26): collapse `TurnLeft (0x6500000E)` into
/// `TurnRight (0x6500000D)` with NEGATED speed. Same retail contract as the
/// sidestep case above — `InterpretedMotionState::ApplyMotion` only carries
/// `TurnRight` (`~/ac-headers/acclient.c:332761-332765`); ACE's
/// `adjust_motion` rewrites `TurnLeft` to `TurnRight` with `speed *= -1`
/// (`MotionInterp.cs:409-412`). The player MotionTable has no
/// `cycles[(stance, TurnLeft)]` entry — the renderer's cache lookup for
/// `0x6500000E` returns null.
///
/// Returns `(motion_command, speed_sign)`.
fn turn_motion_command_for_state(turn: Turn) -> (u32, f32) {
    match turn {
        Turn::Left => (TURN_RIGHT_MOTION_COMMAND, -1.0),
        Turn::Right => (TURN_RIGHT_MOTION_COMMAND, 1.0),
    }
}

pub(super) fn build_motion_state_raw_motion_state(
    world: &WorldState,
    state: MotionState,
    motion_style: MotionStyle,
) -> RawMotionState {
    let run_rate_scalar = player_run_rate_scalar(world);
    let axis_hold_key = hold_key_for_motion_state(state) as u32;
    let mut raw_motion_state = RawMotionState {
        flags: RawMotionFlags::CURRENT_HOLD_KEY,
        current_hold_key: Some(axis_hold_key),
        ..Default::default()
    };

    // Wave 2 Phase 2.2 (2026-05-26): pack forward + sidestep as two
    // independent slots on the wire. The retail / ACE `RawMotionState`
    // schema (`external/ACE/Source/ACE.Server/Physics/Animation/RawMotionState.cs:7-115`,
    // `~/ac-headers/acclient.c:332564-332578`) treats them as three
    // independent fields (forward / sidestep / turn). Pre-2.2 we had a
    // single-valued `Locomotion` enum and lost the sidestep when forward
    // was non-zero — W+D produced `forward_command=WalkForward` only and
    // server / observers saw the player walking straight forward while
    // the local integrator drifted diagonally.
    if let Some(forward) = state.forward {
        let (command, speed) = forward_command_for_state(forward, state.gait, run_rate_scalar);
        raw_motion_state.flags |= RawMotionFlags::FORWARD_COMMAND
            | RawMotionFlags::FORWARD_HOLD_KEY
            | RawMotionFlags::FORWARD_SPEED;
        raw_motion_state.forward_command = Some(command);
        raw_motion_state.forward_hold_key = Some(axis_hold_key);
        raw_motion_state.forward_speed = Some(speed);
    }
    if let Some(sidestep) = state.sidestep {
        raw_motion_state.flags |= RawMotionFlags::SIDE_STEP_COMMAND
            | RawMotionFlags::SIDE_STEP_HOLD_KEY
            | RawMotionFlags::SIDE_STEP_SPEED;
        // Phase 2.5: `sidestep_command_for_state` now always returns
        // `SideStepRight (0x6500000F)` paired with a `±1.0` sign. The
        // sign communicates direction through the existing
        // `sidestep_speed` channel — matches retail
        // `InterpretedMotionState::ApplyMotion` + ACE's
        // `MotionInterp.adjust_motion` (both rewrite Left → Right with
        // negated speed). The renderer's cache lookup hits the Right
        // cycle in MT 0x09000001 either way; pre-Phase-2.5 the Left
        // code missed the cache and the rig silently no-op'd.
        let (command, sign) = sidestep_command_for_state(sidestep);
        raw_motion_state.sidestep_command = Some(command);
        raw_motion_state.sidestep_hold_key = Some(axis_hold_key);
        // Sidestep wire speed stays at the signed unit magnitude —
        // server-side `apply_run_to_command` re-applies `run_factor`
        // scaling and clamps at ±3.0 m/s (`acclient.c:343471-343481`,
        // `MotionInterp.cs:550-560`); both preserve sign. Sending the
        // scaled speed here would double-apply.
        raw_motion_state.sidestep_speed = Some(sign);
    }

    // Wave 2 Phase 2.4 (2026-05-26) — only emit a `turn_command` on
    // the wire when the player is stationary (no forward / sidestep
    // motion). Retail does NOT have a "TurnLeftWhileWalking" clip:
    // when the player is moving + turning, ACE emits ONLY the forward
    // (or sidestep) motion and the yaw integrator handles heading
    // change via modifier-stacking (`~/ac-headers/acclient.c:332771-332786`
    // — `InterpretedMotionState::ApplyMotion` carries forward / sidestep
    // / turn as independent fields, but the visual is a SINGLE locomotion
    // clip with the rig yawing under it, not a layered turn-in-place clip).
    //
    // We keep `state.turning` populated regardless of locomotion so
    // `local_omega_for_state` (this file, below) can drive the local
    // yaw integrator at `movement/system.rs:953-955` — the player must
    // rotate locally on W+Q even though we don't broadcast a Turn cmd
    // to ACE. ACE's server-side `MotionInterp.apply_interpreted_movement`
    // (`external/ACE/Source/ACE.Server/Physics/Animation/MotionInterp.cs:440-504`)
    // applies its own turn integration based on `TurnCommand`; when we
    // suppress the wire-side `turn_command`, the server's heading stays
    // synced to the client's via the subsequent UpdatePosition broadcast.
    //
    // Visual result:
    //   - W+Q : `forward_command = WalkForward`, no `turn_command` on
    //           the wire; player still rotates left as the local
    //           integrator applies omega.z.
    //   - Q alone : `forward_command` absent, `turn_command = TurnLeft`
    //               on the wire; player plays the turn-in-place cycle
    //               from the motion table.
    // Wave 2 Phase 2.2 (2026-05-26): "locomotion active" now means EITHER
    // forward OR sidestep slot is populated. The Phase 2.4 turn-gating
    // rule still holds — retail emits the turn cmd only when the player
    // is stationary; otherwise the locomotion clip carries the heading
    // change via local yaw integration.
    let locomotion_active = !state.is_locomotion_idle();
    if let Some(turn) = state.turning {
        if !locomotion_active {
            raw_motion_state.flags |= RawMotionFlags::TURN_COMMAND
                | RawMotionFlags::TURN_HOLD_KEY
                | RawMotionFlags::TURN_SPEED;
            // Phase 2.5: `turn_motion_command_for_state` now always
            // returns `TurnRight (0x6500000D)` paired with a `±1.0`
            // sign. The sign rides the `turn_speed` channel — matches
            // retail `InterpretedMotionState::ApplyMotion` + ACE's
            // `MotionInterp.adjust_motion` Left → Right rewrite. The
            // motion-table cache lookup for the Right code hits the
            // turn-in-place cycle; pre-Phase-2.5 the Left code missed
            // the cache for MT 0x09000001.
            let (command, sign) = turn_motion_command_for_state(turn);
            raw_motion_state.turn_command = Some(command);
            raw_motion_state.turn_hold_key = Some(axis_hold_key);
            raw_motion_state.turn_speed = Some(wire_turn_speed_for_state(state) * sign);
        }
    }

    raw_motion_state_with_motion_style(world, raw_motion_state, motion_style)
}

/// Wave 10 Phase 10.3 (movement-animation overhaul, 2026-05-26):
/// per-second velocity decay coefficient applied to the player's
/// lateral (X/Y) velocity each tick when grounded.
///
/// The PhatSDK reference value (`CPhysicsObj::DEFAULT_FRICTION = 0.95f`
/// at `external/GDL/PhatSDK/PhysicsObj.cpp:33`) is the *object-level*
/// friction used in retail's `calc_friction` formula
/// `v *= pow(1.0 - friction, quantum)` (`PhysicsObj.cpp:558-559`).
/// Retail's pipeline applies this friction AFTER an explicit
/// `m_Acceleration * quantum` step that sets the new velocity target
/// (`PhysicsObj.cpp:594-598`), so the steady-state speed under
/// continuous run input matches the motion-table's base run velocity.
///
/// The wasm-side integrator skips the explicit-acceleration step (we
/// only consume the input-derived `target_velocity` from
/// `local_velocity_for_state`), so applying `f = 0.95` directly here
/// would create a 25-35% steady-state speed deficit vs the wire
/// (`v_steady = accel*dt/(1-scale)` math diverges with no a-step).
///
/// `0.5` is the wasm-side game-feel value the Phase 10.3 spec called
/// out as a starting point ("50% velocity loss per second on ground
/// when no input"). At 60 Hz the per-tick scale is
/// `pow(0.5, 1/60) ≈ 0.989` — gentle enough that the accel-cap can
/// keep the smoothed velocity within ~3% of the input target at
/// steady state, but firm enough that a release of W decelerates
/// visibly over ~0.5 s instead of snapping. **User-tunable** — bump
/// up for more friction lag, down for crisper response.
pub(super) const PLAYER_GROUND_FRICTION_PER_SEC: f32 = 0.5;

/// Wave 10 Phase 10.3 (2026-05-26): velocity magnitude below which
/// the integrator snaps lateral velocity to zero. Mirrors
/// `small_velocity = 0.25f` in
/// `external/GDL/PhatSDK/PhysicsObj.cpp:41,589` where the retail
/// physics step short-circuits `m_velocityVector = Vector(0,0,0)`
/// when `velocity_mag2 - small_velocity*small_velocity < F_EPSILON`.
pub(super) const PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC: f32 = 0.25;

/// Wave 10 Phase 10.3 (2026-05-26): maximum lateral acceleration in
/// m/s^2 used to cap how fast the player's velocity can transition
/// toward the input-derived target. Retail's
/// `CPhysicsObj::calc_acceleration`
/// (`external/GDL/PhatSDK/PhysicsObj.cpp:1105-1120`) computes
/// acceleration as either `(0,0,gravity)` (airborne with
/// `GRAVITY_PS`) or `(0,0,0)` (grounded); the lateral-axis
/// acceleration comes implicitly from `apply_raw_movement` setting
/// `m_velocityVector` to the input target. There is no explicit
/// retail constant — retail uses friction-only smoothing — but
/// adding an accel cap on top makes the wasm-side prediction feel
/// closer to retail than instant-snap velocity changes. Without
/// the cap, jumping backwards and immediately holding W (the
/// scenario the user smell-tested) would flip the velocity vector
/// instantly on touchdown; with the cap, it ramps through zero.
///
/// Value tuned by feel; the user explicitly flagged this as
/// "documented as a game-feel value to tune later" in the Phase
/// 10.3 spec. 8 m/s^2 lets a stationary player reach a full
/// run-speed (~4.5 m/s) in roughly 0.56 s — slow enough to be
/// visible, fast enough to not feel sluggish.
pub(super) const PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ: f32 = 8.0;

/// Cap for run-scaled sidestep speed in m/s, per retail
/// `CMotionInterp::apply_run_to_command` case `SideStepRight`
/// (`~/ac-headers/acclient.c:343471-343481`) and ACE's
/// `MotionInterp.apply_run_to_command` (`external/ACE/Source/ACE.Server/
/// Physics/Animation/MotionInterp.cs:550-560`). Both clamp `|speed|`
/// to ±3.0 after multiplying by `run_factor`. There is no separate
/// `RunSideStep*` MotionCommand in the AC enum
/// (`external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:22-23` —
/// only SideStepLeft/Right exist), so retail handles "shift+strafe"
/// purely through speed scaling on the existing motion code.
const SIDESTEP_RUN_SPEED_CAP_M_PER_SEC: f32 = 3.0;

/// Wave 2 Phase 2.1 (2026-05-26) + Phase 2.2 (2026-05-26): per-axis speed
/// magnitude used by `local_velocity_for_state` to compose forward +
/// sidestep components.
///
/// Phase 2.1 — backstep + sidestep magnitudes scale by `run_rate_scalar`
/// when shift is held. AC has no `Run{Backward,SideStep*}` enum entries;
/// retail handles "shift+strafe" / "shift+S" via speed scaling on the
/// existing walk-class motion codes. Mirror that here for local prediction;
/// the wire-side keeps speed at 1.0 because ACE's `adjust_motion` +
/// `apply_run_to_command` (`MotionInterp.cs:394-428`) re-applies the
/// scaling server-side. Sending it doubles up.
///
/// Phase 2.2 — split from a single `Locomotion`-keyed match into two
/// independent slot lookups so W+D can return non-zero speeds on BOTH
/// axes simultaneously and the integrator composes the diagonal.
///
/// Sidestep additionally clamps at ±3.0 m/s per retail
/// (`acclient.c:343474-343480` + `MotionInterp.cs:550-560`).
fn forward_axis_speed(state: MotionState, capabilities: &SelfMovementCapabilities) -> f32 {
    match (state.gait, state.forward) {
        (_, None) => 0.0,
        (Gait::Run, Some(ForwardLocomotion::Forward)) => capabilities.resolved_manual_run_speed(),
        (Gait::Walk, Some(ForwardLocomotion::Forward)) => capabilities.base_walk_forward_speed(),
        (Gait::Run, Some(ForwardLocomotion::Backstep)) => capabilities.run_rate_scalar,
        (Gait::Walk, Some(ForwardLocomotion::Backstep)) => 1.0,
    }
}

fn sidestep_axis_speed(state: MotionState, capabilities: &SelfMovementCapabilities) -> f32 {
    match (state.gait, state.sidestep) {
        (_, None) => 0.0,
        (Gait::Run, Some(_)) => capabilities
            .run_rate_scalar
            .min(SIDESTEP_RUN_SPEED_CAP_M_PER_SEC),
        (Gait::Walk, Some(_)) => 1.0,
    }
}

pub(super) fn local_velocity_for_state(
    current_heading: f32,
    state: MotionState,
    capabilities: &SelfMovementCapabilities,
) -> Vector3 {
    // Wave 2 Phase 2.2 (2026-05-26): compose forward + sidestep velocity
    // vectors so W+D drives a diagonal vector, not a single-axis projection.
    // Pre-2.2 the function switched on a single-valued `Locomotion` and
    // dropped the strafe axis when forward was active. Retail's
    // `InterpretedMotionState` carries both axes (`acclient.c:332759-332786`)
    // and the integrator at `system.rs:953-955` consumes whatever vector
    // we hand it.
    //
    // Note: this is GEOMETRIC sum, not the speed-cap-then-project pattern
    // some engines use. AC retail does the same — forward and sidestep are
    // independent contributions to position delta. The combined magnitude
    // can exceed each axis cap (e.g. walk forward at 1.0 + walk sidestep
    // at 1.0 = √2 m/s diagonal). This matches retail behaviour and ACE
    // tolerates the slightly faster diagonal because its position
    // reconciler operates on absolute pose, not motion-derived velocity.
    let mut velocity = Vector3::zero();

    let forward_speed = forward_axis_speed(state, capabilities);
    if let Some(forward) = state.forward {
        let heading = match forward {
            ForwardLocomotion::Forward => current_heading,
            ForwardLocomotion::Backstep => normalize_heading(current_heading + PI),
        };
        // Backstep uses 1.0 magnitude pre-Phase-2.1; the scaling lives in
        // `forward_axis_speed`. For the forward case the magnitude is the
        // resolved walk/run speed.
        let magnitude = match forward {
            ForwardLocomotion::Forward => forward_speed,
            ForwardLocomotion::Backstep => forward_speed,
        };
        velocity = velocity + planar_velocity_for_heading(heading, magnitude);
    }

    if let Some(sidestep) = state.sidestep {
        let sign_heading = match sidestep {
            SidestepLocomotion::StrafeLeft => normalize_heading(current_heading - (PI / 2.0)),
            SidestepLocomotion::StrafeRight => normalize_heading(current_heading + (PI / 2.0)),
        };
        velocity = velocity + planar_velocity_for_heading(sign_heading, sidestep_axis_speed(state, capabilities));
    }

    velocity
}

fn wire_turn_speed_for_state(state: MotionState) -> f32 {
    state.turn_speed.unwrap_or(match state.gait {
        Gait::Run => RUN_HELD_TURN_SPEED_RAD_PER_SEC,
        Gait::Walk => NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC,
    })
}

fn local_turn_omega(base_omega: Vector3, override_speed: Option<f32>) -> Vector3 {
    match override_speed {
        Some(speed) => {
            let base_magnitude = base_omega.length();
            if base_magnitude > 0.0 {
                base_omega.normalize() * speed
            } else {
                Vector3::zero()
            }
        }
        None => base_omega,
    }
}

pub(super) fn local_omega_for_state(
    state: MotionState,
    capabilities: &SelfMovementCapabilities,
) -> Vector3 {
    match state.turning {
        Some(Turn::Right) => local_turn_omega(
            capabilities.kinematics().base_turn_right_omega,
            state.turn_speed,
        ),
        Some(Turn::Left) => local_turn_omega(
            capabilities.kinematics().base_turn_left_omega,
            state.turn_speed,
        ),
        None => Vector3::zero(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_protocol::messages::movement::MotionStance;
    use holtburger_world::{
        PlayerMotionTableSource, SelfMovementCapabilities, SelfMovementKinematics,
    };

    fn test_capabilities() -> SelfMovementCapabilities {
        SelfMovementCapabilities {
            kinematics: SelfMovementKinematics {
                source: PlayerMotionTableSource::DirectProperty {
                    motion_table_id: 0x0900_0020,
                },
                motion_table_id: 0x0900_0020,
                stance: MotionStance::NonCombat as u32,
                base_walk_forward_velocity: Vector3::new(1.0, 0.0, 0.0),
                base_run_forward_velocity: Vector3::new(2.0, 0.0, 0.0),
                base_turn_left_omega: Vector3::new(0.0, 0.0, -1.5),
                base_turn_right_omega: Vector3::new(0.0, 0.0, 1.5),
            },
            run_rate_scalar: 1.0,
        }
    }

    #[test]
    fn local_omega_for_state_preserves_base_turn_omega_without_override() {
        let capabilities = test_capabilities();

        assert_eq!(
            local_omega_for_state(
                MotionState {
                    gait: Gait::Run,
                    forward: None,
                    sidestep: None,
                    turning: Some(Turn::Left),
                    turn_speed: None,
                },
                &capabilities,
            ),
            Vector3::new(0.0, 0.0, -1.5)
        );
    }

    #[test]
    fn local_omega_for_state_applies_turn_speed_override_to_base_direction() {
        let capabilities = test_capabilities();

        assert_eq!(
            local_omega_for_state(
                MotionState {
                    gait: Gait::Walk,
                    forward: None,
                    sidestep: None,
                    turning: Some(Turn::Left),
                    turn_speed: Some(0.75),
                },
                &capabilities,
            ),
            Vector3::new(0.0, 0.0, -0.75)
        );
    }

    /// Wave 2 Phase 2.2 (2026-05-26) — W+D composes a diagonal velocity
    /// vector. `local_velocity_for_state` must return non-zero contributions
    /// from BOTH the forward and sidestep axes. Pre-2.2 the sidestep was
    /// silently dropped when `forward` was active because the function
    /// switched on a single `Locomotion` enum.
    #[test]
    fn local_velocity_for_state_composes_forward_plus_sidestep() {
        let capabilities = test_capabilities();
        let state = MotionState::builder()
            .walk()
            .forward()
            .strafe_right()
            .build();

        // Heading 0 (facing west in AC conventions; planar_velocity_for_heading
        // returns (-cos*speed, sin*speed, 0) so heading=0 gives -X).
        let velocity = local_velocity_for_state(0.0, state, &capabilities);

        // Forward at heading 0 contributes (-1.0, 0.0, 0.0) (walk speed = 1.0
        // m/s by test capabilities `base_walk_forward_velocity`).
        // StrafeRight at heading 0 contributes (-cos(pi/2)*1.0, sin(pi/2)*1.0, 0)
        // = (0.0, 1.0, 0.0).
        // Sum: (-1.0, 1.0, 0.0). Both axes non-zero.
        assert!((velocity.x - (-1.0)).abs() < 1e-5);
        assert!((velocity.y - 1.0).abs() < 1e-5);
        assert!(velocity.z.abs() < 1e-5);
    }

    /// Wave 2 Phase 2.2 (2026-05-26) — `build_motion_state_raw_motion_state`
    /// emits BOTH `forward_command` and `sidestep_command` on the wire when
    /// both axes are populated.
    #[test]
    fn build_motion_state_raw_motion_state_emits_both_forward_and_sidestep() {
        let world = holtburger_world::WorldState::synthetic();
        let state = MotionState::builder()
            .walk()
            .forward()
            .strafe_right()
            .build();

        let raw =
            build_motion_state_raw_motion_state(&world, state, MotionStyle::PreserveServer);

        assert!(raw.flags.contains(RawMotionFlags::FORWARD_COMMAND));
        assert!(raw.flags.contains(RawMotionFlags::SIDE_STEP_COMMAND));
        assert_eq!(raw.forward_command, Some(WALK_FORWARD_MOTION_COMMAND));
        assert_eq!(raw.sidestep_command, Some(SIDESTEP_RIGHT_MOTION_COMMAND));
        assert_eq!(raw.sidestep_speed, Some(1.0));
    }

    /// Wave 2 Phase 2.2 (2026-05-26) — turn-gating (Phase 2.4) holds when
    /// sidestep alone is active: a strafe should still suppress the turn cmd.
    #[test]
    fn build_motion_state_raw_motion_state_suppresses_turn_when_only_sidestep_active() {
        let world = holtburger_world::WorldState::synthetic();
        let state = MotionState::builder()
            .walk()
            .strafe_right()
            .turn_left()
            .build();

        let raw =
            build_motion_state_raw_motion_state(&world, state, MotionStyle::PreserveServer);

        assert!(raw.flags.contains(RawMotionFlags::SIDE_STEP_COMMAND));
        // Turn cmd suppressed because sidestep is active.
        assert!(!raw.flags.contains(RawMotionFlags::TURN_COMMAND));
        assert_eq!(raw.turn_command, None);
    }

    /// Wave 2 Phase 2.5 (2026-05-26) — `Turn::Left` emits the
    /// `TurnRight (0x6500000D)` motion code with a NEGATED `turn_speed`.
    /// Retail collapses Left into Right with negated speed
    /// (`~/ac-headers/acclient.c:332761-332765`), and ACE's
    /// `MotionInterp.adjust_motion` (`external/ACE/Source/ACE.Server/Physics/
    /// Animation/MotionInterp.cs:409-412`) does the same rewrite server-side.
    /// Player MT 0x09000001 lacks a `cycles[(stance, TurnLeft)]` entry, so
    /// the renderer's cache lookup needs the Right code to land a clip.
    #[test]
    fn turn_left_emits_right_code_with_negated_speed() {
        let world = holtburger_world::WorldState::synthetic();
        let state = MotionState::builder().walk().turn_left().build();

        let raw =
            build_motion_state_raw_motion_state(&world, state, MotionStyle::PreserveServer);

        assert!(raw.flags.contains(RawMotionFlags::TURN_COMMAND));
        assert_eq!(
            raw.turn_command,
            Some(TURN_RIGHT_MOTION_COMMAND),
            "Phase 2.5: Turn::Left collapses to TurnRight code",
        );
        // Walk gait → NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC (1.0) negated.
        assert_eq!(
            raw.turn_speed,
            Some(-NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC),
            "Phase 2.5: negated speed signals left direction",
        );
    }

    /// Wave 2 Phase 2.5 (2026-05-26) — `Turn::Right` continues to emit the
    /// `TurnRight (0x6500000D)` motion code with a POSITIVE `turn_speed`.
    /// Regression guard: the Phase 2.5 collapse must not flip the sign for
    /// the canonical right-turn case.
    #[test]
    fn turn_right_emits_right_code_with_positive_speed() {
        let world = holtburger_world::WorldState::synthetic();
        let state = MotionState::builder().walk().turn_right().build();

        let raw =
            build_motion_state_raw_motion_state(&world, state, MotionStyle::PreserveServer);

        assert!(raw.flags.contains(RawMotionFlags::TURN_COMMAND));
        assert_eq!(raw.turn_command, Some(TURN_RIGHT_MOTION_COMMAND));
        assert_eq!(raw.turn_speed, Some(NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC));
    }

    /// Wave 2 Phase 2.5 (2026-05-26) — `SidestepLocomotion::StrafeLeft`
    /// emits the `SideStepRight (0x6500000F)` motion code with a NEGATED
    /// `sidestep_speed`. Same retail / ACE contract as `turn_left_emits_
    /// right_code_with_negated_speed` above; the player MotionTable's
    /// `cycles[(stance, SideStepLeft)]` is empty across all 13 stances.
    #[test]
    fn sidestep_left_emits_right_code_with_negated_speed() {
        let world = holtburger_world::WorldState::synthetic();
        let state = MotionState::builder().walk().strafe_left().build();

        let raw =
            build_motion_state_raw_motion_state(&world, state, MotionStyle::PreserveServer);

        assert!(raw.flags.contains(RawMotionFlags::SIDE_STEP_COMMAND));
        assert_eq!(
            raw.sidestep_command,
            Some(SIDESTEP_RIGHT_MOTION_COMMAND),
            "Phase 2.5: StrafeLeft collapses to SideStepRight code",
        );
        assert_eq!(
            raw.sidestep_speed,
            Some(-1.0),
            "Phase 2.5: negated unit speed signals left direction",
        );
    }

    /// Wave 2 Phase 2.5 (2026-05-26) — `SidestepLocomotion::StrafeRight`
    /// continues to emit the `SideStepRight (0x6500000F)` motion code with a
    /// POSITIVE `sidestep_speed`. Regression guard for the canonical case.
    #[test]
    fn sidestep_right_emits_right_code_with_positive_speed() {
        let world = holtburger_world::WorldState::synthetic();
        let state = MotionState::builder().walk().strafe_right().build();

        let raw =
            build_motion_state_raw_motion_state(&world, state, MotionStyle::PreserveServer);

        assert!(raw.flags.contains(RawMotionFlags::SIDE_STEP_COMMAND));
        assert_eq!(raw.sidestep_command, Some(SIDESTEP_RIGHT_MOTION_COMMAND));
        assert_eq!(raw.sidestep_speed, Some(1.0));
    }
}
