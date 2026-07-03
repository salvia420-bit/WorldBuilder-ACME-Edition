use crate::client::movement_types::{
    ForwardLocomotion, Gait, MotionState, MotionStyle, MovementPacketMetadata, SidestepLocomotion,
    Turn, planar_velocity_for_heading,
};
use holtburger_common::{Guid, Vector3};
use holtburger_protocol::messages::game_action::*;
use holtburger_protocol::messages::game_message::{RawMotionFlags, RawMotionState};
use holtburger_protocol::messages::*;
use holtburger_world::{SelfMovementCapabilities, WorldState};
use std::f32::consts::{PI, TAU};
use std::time::Duration;

// F1-7 (movement bughunt 2026-06-09): the old `FALLBACK_RUN_RATE_SCALAR =
// 4.5` is GONE. It leaked the MAXIMUM run rate (an 18 m/s runner) onto the
// wire for any player whose Run skill hadn't hydrated, while the local
// fallback caps moved at 4.5 m/s — a 4× wire/local mismatch that rubber-
// banded the player for every observer. Post-F5-2 the raw wire never
// carries a run rate at all (WalkForward + HoldKey=Run + speed 1.0; ACE
// derives GetRunRate server-side from ITS OWN view of the player's Run
// skill), so no wire-side fallback is needed. The LOCAL fallback caps live
// in `apps/holtburger-web/src/lib.rs` (three install sites, `run_rate_
// scalar: 1.0` + retail base velocities).
pub(super) const AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
pub(super) const WALK_FORWARD_MOTION_COMMAND: u32 = 0x4500_0005;
const WALK_BACKWARD_MOTION_COMMAND: u32 = 0x4500_0006;
// F5-2/F2-1 (movement bughunt 2026-06-09): `RunForward (0x44000007)` is the
// INTERPRETED-state code — it must NEVER go on the raw C2S wire, and the
// constant that used to live here is deleted so it can't creep back in.
// See `forward_command_for_state` for the full broadcast-converter
// rationale (`MovementData.cs:99-119`).
pub(super) const TURN_RIGHT_MOTION_COMMAND: u32 = 0x6500_000d;
// F5-1 (movement bughunt 2026-06-09): the RAW C2S wire carries the REAL
// sidestep enum — `SideStepLeft (0x65000010)` for a left strafe — because
// ACE's broadcast converter (`ACE.Server/Network/Motion/MovementData.cs:
// 123-131`) derives the observers' direction ONLY from the raw enum:
// `interpState.SidestepSpeed = speed * 3.12f/1.25f*0.5f;` (always positive)
// `if (rawState.SidestepCommand == MotionCommand.SideStepLeft)
//      interpState.SidestepSpeed *= -1;`
// — it never reads the client's raw `SidestepSpeed` sign. The Wave-2
// Phase-2.5 collapse (Left → Right + negated speed) applied the
// INTERPRETED-state canonicalization to the raw layer, so every observer
// saw a left-strafing player strafe RIGHT until the ~1 Hz heartbeat
// snapped them back. ACE's own `RawMotionState.cs:38-40` comment documents
// that the one-direction+negated-speed convention applies to the TURN raw
// field ONLY — so the turn collapse below stays (retail-correct), and the
// sidestep collapse is reverted. The Left→Right rewrite (with negated
// speed) is the SERVER's job in the broadcast; observers therefore still
// only ever receive `SideStepRight` and the renderer's MT cache lookup
// (which has no SideStepLeft cycles) is unaffected.
const SIDESTEP_RIGHT_MOTION_COMMAND: u32 = 0x6500_000f;
const SIDESTEP_LEFT_MOTION_COMMAND: u32 = 0x6500_0010;
// F1-3 (movement bughunt 2026-06-09): the raw wire turn speed is a
// dimensionless anim-rate scalar, base 1.0 — NOT a pre-scaled rad/s value.
// Retail sends raw 1.0 and lets `adjust_motion → apply_run_to_command`
// apply `RunTurnFactor = 1.5` exactly once server-side when
// `TurnHoldKey == Run` (`MotionInterp.cs:29,546-548`). The previous
// `RUN_HELD_TURN_SPEED_RAD_PER_SEC = 1.5` pre-multiplied the factor into
// the wire value while ALSO sending `turn_hold_key = Run`, so ACE applied
// it again — observers integrated stationary turns at 2.25× while the
// local predictor (which never applied the factor at all) turned at 1.0×.
// The factor now lives on the LOCAL side only (`local_omega_for_state`).
pub(super) const WIRE_TURN_SPEED_BASE: f32 = 1.0;
/// Retail `CMotionInterp` `RunTurnFactor` (ACE `MotionInterp.cs:29`):
/// turn omega multiplier while the Run key is held. Applied locally in
/// [`local_omega_for_state`]; the wire sends the raw base speed and ACE
/// applies this same factor server-side from the hold key.
pub(super) const RUN_TURN_FACTOR: f32 = 1.5;

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
    // F2-2 (movement bughunt 2026-06-09): the LOCAL airborne state is the
    // source of truth for the wire contact bit. The previous fallback chain
    // (`last_server_grounded.unwrap_or(true)`) misused the server's echo of
    // our own reports as local state: ACE rarely sends self UpdatePosition
    // outside corrections, so the byte was effectively a constant `1` even
    // mid-jump/fall. ACE consumes it hard — `GameActionAutonomousPosition.cs:
    // 26-28` updates `LastGroundPos` (the z-hack reference) whenever it's
    // set, and `PhysicsObj.cs:3474` force-installs a terrain ContactPlane on
    // cell change while `player.LastContact` is true, falsely re-grounding
    // an airborne player in server physics. `is_airborne` is maintained by
    // the integrator (`begin_jump`/`begin_fall`/`land`) and is current the
    // tick it changes — which also makes the in-window contact-flip
    // heartbeat re-send (`autonomous_pose_changed`, built precisely for the
    // airborne flip) live for the first time.
    metadata.contact.unwrap_or(!world.player.is_airborne)
}

/// MoveToState trailing byte: bit 0x1 = Contact (on ground), bit 0x2 =
/// StandingLongJump (ACE `MoveToState.cs:43-48`). The long-jump bit is set
/// while a jump charge began from a grounded standstill (F1-6) — ACE's
/// broadcast converter excludes Forward/Sidestep from the observer
/// broadcast while it's set (`MovementData.cs:104,123` — without that
/// exclusion observers see "a buggy shallow arc jump", per ACE's own
/// comment).
pub(super) fn encode_contact_long_jump(world: &WorldState, metadata: MovementPacketMetadata) -> u8 {
    let mut byte = u8::from(resolve_contact(world, metadata));
    if world.player.standing_long_jump_charge {
        byte |= 0x2;
    }
    byte
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

/// Single MoveToState constructor — the timestamp quartet
/// (instance/server_control/teleport/force_position) is read from
/// `world.player` in exactly one place, mirroring retail's single
/// MoveToStatePack ctor site in `CommandInterpreter::SendMovementEvent`
/// (acclient.c:718175-718187: `update_times[8]/[5]/[4]/[6]` feed the one
/// pack ctor; the three pulse kinds all flow through it). A13-W3.
pub(super) fn build_move_to_state(
    world: &WorldState,
    raw_motion_state: RawMotionState,
    metadata: MovementPacketMetadata,
) -> MoveToStateActionData {
    MoveToStateActionData {
        raw_motion_state,
        position: world.local_player_runtime_pose().unwrap_or_default(),
        instance_sequence: world.player.instance_sequence,
        server_control_sequence: world.player.server_control_sequence,
        teleport_sequence: world.player.teleport_sequence,
        force_position_sequence: world.player.force_position_sequence,
        contact_long_jump: encode_contact_long_jump(world, metadata),
    }
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

/// A14-I4 (W3+ S11) — single Jump constructor, completing the A13
/// single-builder shape: after this, every outbound movement pack
/// (MoveToState ×3 pulse kinds, AutonomousPosition ×2 sites, Jump) is
/// constructed in this module and dispatched via the one
/// counter-stamped funnel `Session::send_action`. Mirrors retail's
/// single `JumpPack` ctor site in `ClientCombatSystem::DoJump`
/// (acclient.c:408184-408192: `update_times[8]/[5]/[4]/[6]` — the same
/// quartet slots both position packs read at acclient.c:718175-718178).
///
/// ACE trailer kept deliberately: `object_guid` + `spell_id: 0` and the
/// OMITTED Position are the ACE-sanctioned `JumpPack.cs` shape
/// (ROADMAP §8 do-not-do; `validate_wire_conformance.cjs` memo).
pub(super) fn build_jump(world: &WorldState, extent: f32, velocity: Vector3) -> JumpActionData {
    JumpActionData {
        extent,
        velocity,
        instance_sequence: world.player.instance_sequence,
        server_control_sequence: world.player.server_control_sequence,
        teleport_sequence: world.player.teleport_sequence,
        force_position_sequence: world.player.force_position_sequence,
        object_guid: world.player.guid,
        spell_id: 0,
    }
}

fn hold_key_for_motion_state(state: MotionState) -> HoldKey {
    match state.gait {
        Gait::Run => HoldKey::Run,
        Gait::Walk => HoldKey::None,
    }
}

/// F5-2/F2-1 (movement bughunt 2026-06-09): the raw C2S wire ALWAYS
/// carries the walk-class motion code — `WalkForward` for both gaits —
/// with speed 1.0; the Run gait is communicated exclusively through the
/// hold keys (`forward_hold_key` / `current_hold_key` = `HoldKey::Run`,
/// already set by the caller). This is retail's raw encoding, and it is
/// the ONLY encoding ACE's broadcast converter attaches the run rate to:
/// `MovementData.cs:99-117` computes `speed = holdKey == Run ?
/// creature.GetRunRate() : 1.0` and assigns it ONLY inside the
/// `ForwardCommand == WalkForward || WalkBackwards` branch (which also
/// performs the WalkForward→RunForward swap for the broadcast). The
/// Wave-2 Phase-2.3 raw-`RunForward` encoding fell through the
/// converter's `else` and was re-broadcast at the implicit speed 1.0 —
/// every observer saw the runner at base 4.0 m/s + heartbeat snaps (see
/// the `RUN_FORWARD_MOTION_COMMAND` doc above).
///
/// The local renderer is unaffected: the run clip is dispatched from the
/// JS input layer (`index.html` ~10518 `em.setMotion(localGuid,
/// RunForward …)`), and ACE's canonicalized `RunForward` echo to the
/// originator is swallowed by the B9 local-guid locomotion skip
/// (`loop.js`). The client-side raw `ForwardSpeed` is never read by
/// ACE's converter, so 1.0 is also what retail sends there.
///
/// Backstep keeps its walk-class motion code regardless of gait
/// (no `RunBackward` enum entry exists; see
/// `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:13-23`).
/// Speed scaling for backstep is handled at the local-prediction
/// layer per Phase 2.1; on the wire it stays at 1.0 because ACE's
/// `adjust_motion` + `apply_run_to_command` re-applies the scaling
/// server-side (the negative rewritten speed keeps the command
/// `WalkForward`, picking up `GetRunRate` in the same branch).
fn forward_command_for_state(forward: ForwardLocomotion, _gait: Gait) -> (u32, f32) {
    match forward {
        ForwardLocomotion::Forward => (WALK_FORWARD_MOTION_COMMAND, 1.0),
        ForwardLocomotion::Backstep => (WALK_BACKWARD_MOTION_COMMAND, 1.0),
    }
}

/// F5-1 (movement bughunt 2026-06-09): the RAW C2S wire carries the REAL
/// sidestep enum — `SideStepLeft (0x65000010)` with POSITIVE unit speed
/// for a left strafe — because ACE's broadcast converter derives the
/// observers' strafe direction ONLY from the raw enum and never reads the
/// raw speed's sign (`MovementData.cs:123-131`; see the
/// `SIDESTEP_LEFT_MOTION_COMMAND` doc above). The Left→Right rewrite with
/// negated speed is the SERVER's interpreted-state canonicalization
/// (`MotionInterp.adjust_motion` `MotionInterp.cs:414-417` for physics,
/// `MovementData.cs:130-131` for the broadcast) — pre-applying it on the
/// raw wire inverted every observer's view of a left strafe.
///
/// No `RunSideStep*` enum entries exist (`MotionCommand.cs:22-23`); the
/// Run gait rides the hold keys and `apply_run_to_command` re-applies the
/// scaling server-side (clamping the ANIM RATE at ±3.0 — see
/// `MAX_SIDESTEP_ANIM_RATE`). Speed on the wire stays at 1.0.
///
/// Local consumers are unaffected: prediction velocity comes from
/// `local_velocity_for_state` (keyed off the `SidestepLocomotion` enum,
/// not this wire code), and the local rig's strafe overlay is driven from
/// the JS input layer (`index.html` `setSidestepLayer`). Observers still
/// only ever RECEIVE `SideStepRight ± speed` (ACE canonicalizes), so the
/// renderer's MT cache (which has no SideStepLeft cycles) never sees the
/// Left code.
///
/// Returns `(motion_command, speed_sign)`. The caller multiplies the
/// resolved base speed by this sign to produce the signed wire-side speed.
fn sidestep_command_for_state(sidestep: SidestepLocomotion) -> (u32, f32) {
    match sidestep {
        SidestepLocomotion::StrafeLeft => (SIDESTEP_LEFT_MOTION_COMMAND, 1.0),
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
        let (command, speed) = forward_command_for_state(forward, state.gait);
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
        // F5-1: the REAL enum (SideStepLeft / SideStepRight) goes on the
        // raw wire with positive unit speed — ACE's broadcast converter
        // reads direction from the enum only (`MovementData.cs:123-131`)
        // and performs the Left→Right+negate rewrite itself. See
        // `sidestep_command_for_state`.
        let (command, sign) = sidestep_command_for_state(sidestep);
        raw_motion_state.sidestep_command = Some(command);
        raw_motion_state.sidestep_hold_key = Some(axis_hold_key);
        // Sidestep wire speed stays at the unit magnitude — server-side
        // `apply_run_to_command` re-applies `run_factor` scaling and
        // clamps the anim rate at ±3.0 (`acclient.c:343471-343481`,
        // `MotionInterp.cs:550-560`). Sending the scaled speed here
        // would double-apply.
        raw_motion_state.sidestep_speed = Some(sign);
    }

    // F2-4 (movement bughunt 2026-06-09): the turn fields are RAW INPUT
    // state — emit them whenever the turn key is held, INDEPENDENT of
    // forward/sidestep. The Wave-2 Phase-2.4 gate (turn only when
    // stationary) conflated the interpreted-state ANIMATION question (no
    // turn-in-place clip layered while moving — true) with the raw wire
    // schema (turn keys are always reported — also true): retail's
    // `RawMotionState::ApplyMotion` (`acclient.c:332852-332889`, cases
    // 0x6500000D/0x6500000E) writes turn_command+holdkey+speed into the
    // raw state regardless of the forward/sidestep slots, and ACE's
    // broadcast converter handles TurnCommand independently of locomotion
    // (`MovementData.cs:134-148` — only StandingLongJump gates forward/
    // sidestep; turn is ungated; `RawMotionState.cs:38-42` documents the
    // turn channel as always-sent raw input, including mouselook). With
    // the gate, observers got NO heading information while a player ran
    // in a curve (W+Q/E) — they saw a dead-straight run that snapped
    // heading at each ~1 s AutonomousPosition heartbeat.
    //
    // Receiving-renderer note: remote rigs only yaw from the broadcast
    // turn (the heading-ease consumes position quaternions; KIND_MOTION
    // carries the forward command), so un-gating cannot layer a spurious
    // turn-in-place clip over a locomotion clip on our own clients.
    //
    // Visual result:
    //   - W+Q : `forward_command = WalkForward` AND `turn_command =
    //           TurnRight×(−speed)` on the wire; observers integrate the
    //           curve between heartbeats.
    //   - Q alone : `turn_command` only; player plays the turn-in-place
    //               cycle from the motion table.
    if let Some(turn) = state.turning {
        raw_motion_state.flags |= RawMotionFlags::TURN_COMMAND
            | RawMotionFlags::TURN_HOLD_KEY
            | RawMotionFlags::TURN_SPEED;
        // Phase 2.5 collapse (KEPT — this one is retail-correct): the
        // raw wire carries `TurnRight (0x6500000D)` with a signed
        // speed for both directions. ACE's own `RawMotionState.cs:38-40`
        // comment documents the one-direction+negative-speed convention
        // as the RAW-wire contract for the turn field (and ONLY the
        // turn field — contrast the F5-1 sidestep revert above), and
        // `MovementData.cs:141-145` passes the signed raw TurnSpeed
        // through to the broadcast.
        let (command, sign) = turn_motion_command_for_state(turn);
        raw_motion_state.turn_command = Some(command);
        raw_motion_state.turn_hold_key = Some(axis_hold_key);
        raw_motion_state.turn_speed = Some(wire_turn_speed_for_state(state) * sign);
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

// ---------------------------------------------------------------------------
// Grounded friction model (physics deep-dive 2026-06-01, gap — Dimension 3).
//
// The decay *form* `v *= pow(1 - friction, quantum)` (gated on grounded +
// the `0.25` small-velocity snap) already matched retail. What we omitted was
// (a) the contact-plane projection that strips the into-surface velocity
// component before damping, and (b) the SLEDDING overrides on a near-flat
// slope. [`calc_friction`] ports both, 1:1 with ACE
// `PhysicsObj.calc_friction` (`external/ACE/Source/ACE.Server/Physics/
// PhysicsObj.cs:2120-2141`) — the readable proxy for retail
// `CPhysicsObj::calc_friction` (`~/ac-headers/acclient.c`).

/// Retail object-level ground friction coefficient, `PhysicsGlobals
/// .DefaultFriction = 0.95f` (`external/ACE/Source/ACE.Server/Physics/
/// PhysicsGlobals.cs:15`; retail `CPhysicsObj` ctor sets `m_friction =
/// DEFAULT_FRICTION`). Used by the retail friction path
/// ([`super::system::USE_RETAIL_GROUND_FRICTION`]) in place of the gentler
/// hand-tuned [`PLAYER_GROUND_FRICTION_PER_SEC`] (`0.5`).
///
/// Why this is *not* the default: the Phase-1 grounding for the deep-dive
/// confirmed (high confidence) that retail does **not** re-set the
/// friction-decayed velocity to the input target each tick — friction
/// *compounds* — but it also found that *grounded walking never uses that
/// re-set channel*. So the open question the in-code `0.5` rationale raised
/// (does applying `0.95` directly cause a 25-35% steady-state deficit *in our
/// architecture*?) is **not** resolved in favour of `0.95`: our pipeline
/// smooths a stored velocity toward the input target with an accel cap and no
/// explicit `Acceleration*quantum` step, so the steady-state interaction of
/// `0.95` with that cap is a feel-affecting unknown that needs live eyes on
/// the 1070. The coefficient is therefore gated behind a default-OFF A/B flag;
/// the *projection* and *sledding* fidelity ride along regardless (low risk —
/// a no-op on flat ground).
pub(super) const PLAYER_GROUND_FRICTION_RETAIL: f32 = 0.95;

/// SLEDDING low-speed override: when sledding and `velocity_mag^2` is below
/// this, friction is forced to `1.0` (full stop within the quantum). Retail
/// `calc_friction` (`PhysicsObj.cs:2132-2133`): `velocity_mag2 < 1.5625f`.
/// `1.5625 = 1.25^2` (1.25 m/s).
pub(super) const SLEDDING_LOW_VELOCITY_SQ: f32 = 1.5625;

/// SLEDDING high-speed override: when sledding *and* on a STEEP slope
/// (`ContactPlane.Normal.Z < SLEDDING_STEEP_NORMAL_Z`) and `velocity_mag^2`
/// is at/above this, friction stays at `0.2` (near-frictionless glide — the
/// retail mountain-slide). Retail `calc_friction` (acclient.c:316124-316128):
/// `velocity_mag2 >= 6.25f`. `6.25 = 2.5^2` (2.5 m/s).
pub(super) const SLEDDING_HIGH_VELOCITY_SQ: f32 = 6.25;

/// Steep-slope cutoff gating the SLEDDING high-speed override: the glide
/// survives only when `ContactPlane.Normal.Z <` this (slope steeper than
/// 10°). Retail `calc_friction` (acclient.c:316127): `if (velocity_mag2 <
/// 6.25 || cos(0.1745329251994329) <= N.z) frict = this->friction;` — i.e.
/// friction stays `0.2` iff fast AND `N.z < cos(10°)`. `0.98480775` shares
/// f32 bits (0x3F7C1C5C) with `cos(10°)` narrowed. ACE inverted this gate
/// (`PhysicsObj.cs:2135` `N.z > 0.99999536` — glide on DEAD-FLAT ground);
/// the old `SLEDDING_FLAT_NORMAL_Z = 0.99999536` port inherited the bug.
pub(super) const SLEDDING_STEEP_NORMAL_Z: f32 = 0.98480775;

/// Into-surface early-return cutoff. Retail `calc_friction`
/// (`PhysicsObj.cs:2125`): if `dot(Velocity, ContactPlane.Normal) >= 0.25f`
/// the object is moving *away* from the surface fast enough that no friction
/// applies this quantum. `0.25` is the same magnitude as
/// [`PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC`] (retail `SmallVelocity`),
/// reused here as the surface-separation gate.
pub(super) const FRICTION_AWAY_FROM_SURFACE_CUTOFF: f32 = 0.25;

/// Port of ACE `PhysicsObj.calc_friction` (`external/ACE/Source/ACE.Server/
/// Physics/PhysicsObj.cs:2120-2141`) — the 1:1 readable proxy for retail
/// `CPhysicsObj::calc_friction`.
///
/// Mutates `velocity` in place (full 3D, like retail's `m_velocityVector`):
/// 1. `angle = dot(velocity, normal)` (the into/out-of-surface component).
/// 2. Early-return if `angle >= FRICTION_AWAY_FROM_SURFACE_CUTOFF` — the
///    object is separating from the surface; no friction this quantum.
/// 3. `velocity -= normal * angle` — strip the into-surface component
///    *before* damping (on flat ground `angle ≈ 0`, so this is a no-op).
/// 4. SLEDDING overrides (only when `sledding`): force friction to `1.0`
///    below [`SLEDDING_LOW_VELOCITY_SQ`], or to `0.2` at/above
///    [`SLEDDING_HIGH_VELOCITY_SQ`] on a STEEP (>10°) slope
///    (acclient.c:316124-316131).
/// 5. `velocity *= pow(1 - friction, quantum)`.
///
/// `normal` must be unit length (the contact-plane normal). `velocity_mag2`
/// is the caller's pre-projection `velocity.length_squared()` — matches ACE,
/// which passes `Velocity.LengthSquared()` (post-`MaxVelocity` clamp) from
/// `UpdatePhysicsInternal` (`PhysicsObj.cs:1834,1849`).
pub(super) fn calc_friction(
    velocity: &mut Vector3,
    normal: Vector3,
    velocity_mag2: f32,
    friction: f32,
    sledding: bool,
    quantum: f32,
) {
    let angle = velocity.dot(&normal);
    if angle >= FRICTION_AWAY_FROM_SURFACE_CUTOFF {
        return;
    }
    *velocity = *velocity - normal * angle;

    let mut friction = friction;
    if sledding {
        if velocity_mag2 < SLEDDING_LOW_VELOCITY_SQ {
            friction = 1.0;
        } else if velocity_mag2 >= SLEDDING_HIGH_VELOCITY_SQ && normal.z < SLEDDING_STEEP_NORMAL_Z {
            // Fast on a steep slope: the 0.2 glide survives
            // (acclient.c:316127 — `frict` seeds 0.2 and only resets to
            // object friction when slow OR `cos(10°) <= N.z`).
            friction = 0.2;
        }
    }

    let scalar = (1.0 - friction).powf(quantum);
    *velocity = *velocity * scalar;
}

// ---------------------------------------------------------------------------
// Quantum-subdivided integration loop constants (physics deep-dive
// 2026-06-01, gaps 1 + 7).
//
// These mirror ACE's `PhysicsGlobals` 1:1 — the readable 1:1 port of
// retail's `update_object` timestep gate (`external/ACE/Source/
// ACE.Server/Physics/PhysicsObj.cs:4140-4190`,
// `PhysicsGlobals.cs:13,30,38,41,43`). The wasm-side authoritative
// integrator previously consumed the raw, unbounded per-frame rAF
// `dt` and integrated exactly once, so a tab-refocus / GC / driver
// throttle hitch over-integrated a fall in one giant step (the
// documented "~25 m/s overshoot"). Wrapping the per-frame step in
// the clamp-and-subdivide loop below bounds the per-slice motion to
// `MAX_QUANTUM`, terminal-clamps velocity to `MAX_VELOCITY`, and
// drops a `HUGE_QUANTUM`-or-larger hitch entirely — matching retail.
//
// We intentionally do NOT reach into ACE for these values; they are
// defined here so the crate is self-contained.
//
// Decision record (MAX_QUANTUM 0.1-vs-retail-0.2, MIN_QUANTUM regimes, JS
// dt-clamp, HitGround omission): apps/holtburger-web/docs/
// 2026-06-11-unification-survey/DECISIONS-A1-O5-constants.md.

/// Minimum integration slice in seconds. ACE floors the per-frame
/// remainder at this value and skips integrating a slice smaller than
/// it (`PhysicsGlobals.MinQuantum = 1.0f / 30.0f`,
/// `PhysicsObj.cs:4182`). 1/30 s ≈ 0.0333 s (30 fps).
pub(super) const MIN_QUANTUM: f32 = 1.0 / 30.0;

/// Maximum integration slice in seconds. ACE subdivides every frame
/// into `<= MAX_QUANTUM` slices (`PhysicsGlobals.MaxQuantum = 0.1f`,
/// `PhysicsObj.cs:4175-4180`). 0.1 s = 10 fps; any frame longer than
/// this is integrated as a sequence of 0.1 s slices so a single long
/// frame cannot over-integrate gravity in one step.
pub(crate) const MAX_QUANTUM: f32 = 0.1;

/// Frame duration above which the whole frame is dropped (no
/// integration). ACE returns early and consumes the time without
/// advancing the object (`PhysicsGlobals.HugeQuantum = 2.0f`,
/// `PhysicsObj.cs:4169-4173`). A hitch this large (>= 2 s — tab
/// backgrounded, long GC, debugger pause) would otherwise teleport a
/// falling player; retail simply skips it and lets the next frame /
/// server correction resync.
pub(crate) const HUGE_QUANTUM: f32 = 2.0;

/// Terminal velocity clamp in m/s. ACE clamps the total velocity
/// magnitude to this every quantum inside `UpdatePhysicsInternal`
/// (`PhysicsGlobals.MaxVelocity = 50.0f`,
/// `PhysicsObj.cs:1843-1846`). A long fall would otherwise accelerate
/// unbounded; retail caps it at 50 m/s.
pub(super) const MAX_VELOCITY: f32 = 50.0;

/// Retail `update_object` entry epsilon: a frame of `dt <= 0.0002` s is
/// CONSUMED (update_time = cur_time) and nothing integrates
/// (acclient.c:323123 `if (v6 > 0.00019999999)`). `0.0002_f32` shares
/// bits (0x3951B717) with retail's printed 0.00019999999. Read by the
/// retail quantum loop (`USE_RETAIL_QUANTUM`, system.rs) only.
pub(super) const PHYSICS_ENTRY_EPSILON: f32 = 0.0002;

/// Retail `MAX_QUANTUM_97 = 1.0 / 5.0` (acclient.c:784235): the slice
/// size of the RETAIL loop shape — `dt <= 0.2` integrates directly as
/// ONE quantum (:323127 `goto LABEL_21`), larger frames slice at 0.2.
/// Distinct from the shipped [`MAX_QUANTUM`] (0.1, the deliberate
/// DECISIONS-A1-O5 deviation); read by the retail quantum loop
/// (`USE_RETAIL_QUANTUM`, system.rs) only.
pub(super) const RETAIL_MAX_QUANTUM: f32 = 0.2;

/// F1-2 (movement bughunt 2026-06-09): retail's `±3.0` sidestep clamp is
/// an ANIM-RATE cap, NOT a m/s cap. `apply_run_to_command`
/// (`MotionInterp.cs:550-560`, `acclient.c:343471-343481`) clamps the
/// dimensionless `speed` scalar at `MaxSidestepAnimRate = 3.0`
/// (`MotionInterp.cs:27`) AFTER multiplying by `run_factor`;
/// `get_state_velocity` (`MotionInterp.cs:682-683`) then converts to m/s
/// by multiplying `SidestepAnimSpeed = 1.25`. So the retail m/s ceiling
/// is `3.0 × 1.25 = 3.75 m/s`. The previous name/doc
/// (`SIDESTEP_RUN_SPEED_CAP_M_PER_SEC`) misread the clamp as m/s — one
/// of the two halves of the uniform ~36% strafe-speed deficit.
const MAX_SIDESTEP_ANIM_RATE: f32 = 3.0;

/// ACE `MotionInterp.SidestepAnimSpeed = 1.25f` (`MotionInterp.cs:31`):
/// the m/s velocity per unit sidestep anim rate in `get_state_velocity`
/// (`velocity.X = SidestepAnimSpeed * SideStepSpeed`,
/// `MotionInterp.cs:682-683`).
const SIDESTEP_ANIM_SPEED: f32 = 1.25;

/// ACE `adjust_motion`'s SideStep speed adjustment
/// (`MotionInterp.cs:420-421`): `speed *= SidestepFactor(0.5) ×
/// (WalkAnimSpeed 3.1199999 / SidestepAnimSpeed 1.25) = 1.248`, applied
/// to ALL SideStep motions before the run scaling. Retail decomp
/// cross-check `acclient.c:343471-343481`. Combined with
/// [`SIDESTEP_ANIM_SPEED`], the net retail strafe speeds are:
/// walk `1.25 × 1.248 = 1.56 m/s`; run `1.25 × min(1.248 × run_rate,
/// 3.0)` up to `3.75 m/s`. The pre-fix arms (walk `1.0`, run
/// `min(run_rate, 3.0)`) dropped both factors.
const SIDESTEP_ADJUST_FACTOR: f32 = 1.248;

/// Backstep magnitude factor relative to the walk-forward base speed,
/// per retail. ACE's `MotionInterp.adjust_motion` rewrites
/// `WalkBackwards` to `WalkForward` with `speed *= -BackwardsFactor`
/// (`external/ACE/Source/ACE.Server/Physics/Animation/MotionInterp.cs:404-406`,
/// `BackwardsFactor = 6.4999998e-1f` at line 26; decomp cross-check
/// `~/ac-headers/acclient.c:343466`). `get_state_velocity` then computes
/// `velocity.Y = WalkAnimSpeed * ForwardSpeed` for a `WalkForward`
/// command (`MotionInterp.cs:684-685`), so the backstep magnitude is
/// `WalkAnimSpeed * BackwardsFactor` (3.12 * 0.65 ≈ 2.03 m/s) — i.e. the
/// walk-forward base speed scaled by this factor. There is no
/// `RunBackward*` MotionCommand (`MotionCommand.cs:13-23`); the Run gait
/// instead applies the `run_factor` on top via `apply_run_to_command`'s
/// `WalkForward` arm (`MotionInterp.cs:539-543`, which leaves the command
/// `WalkForward` because the rewritten speed is negative and only
/// `speed > 0` promotes to `RunForward`).
const BACKWARDS_FACTOR: f32 = 0.649_999_98;

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
/// GAP 5 (2026-06-01) — backstep magnitude correction. The pre-fix arms
/// returned the bare `run_rate_scalar` (~4.5) for `(Run, Backstep)` and
/// `1.0` for `(Walk, Backstep)` — misusing a dimensionless run-rate
/// multiplier as a raw m/s magnitude. Retail backstep is the walk-forward
/// base speed scaled by `BackwardsFactor` (`WalkAnimSpeed * 0.65 ≈ 2.03`
/// m/s for the canonical walk base), and the Run gait additionally applies
/// the `run_factor` (`run_rate_scalar`) on top — see `BACKWARDS_FACTOR`.
/// We derive the magnitude from `base_walk_forward_speed()` so backstep
/// stays consistent with however the walk-forward base is sourced (the
/// separate walk-forward-magnitude question is out of scope here).
///
/// Sidestep additionally clamps at ±3.0 m/s per retail
/// (`acclient.c:343474-343480` + `MotionInterp.cs:550-560`).
fn forward_axis_speed(state: MotionState, capabilities: &SelfMovementCapabilities) -> f32 {
    match (state.gait, state.forward) {
        (_, None) => 0.0,
        (Gait::Run, Some(ForwardLocomotion::Forward)) => capabilities.resolved_manual_run_speed(),
        (Gait::Walk, Some(ForwardLocomotion::Forward)) => capabilities.base_walk_forward_speed(),
        (Gait::Run, Some(ForwardLocomotion::Backstep)) => {
            capabilities.base_walk_forward_speed() * BACKWARDS_FACTOR * capabilities.run_rate_scalar
        }
        (Gait::Walk, Some(ForwardLocomotion::Backstep)) => {
            capabilities.base_walk_forward_speed() * BACKWARDS_FACTOR
        }
    }
}

/// F1-2 (movement bughunt 2026-06-09): retail strafe speed chain —
/// `adjust_motion` applies `SIDESTEP_ADJUST_FACTOR` (1.248) to the unit
/// input, `apply_run_to_command` multiplies by `run_rate` and clamps the
/// ANIM RATE at 3.0, and `get_state_velocity` converts to m/s via
/// `SidestepAnimSpeed` (1.25). Net: walk strafe `1.56 m/s`, run strafe
/// `min(1.248 × run_rate, 3.0) × 1.25` up to `3.75 m/s`. The pre-fix
/// values (walk 1.0, run `min(run_rate, 3.0)`) were 0.64× retail below
/// the clamp knee and 0.8× at the maxed run rate.
fn sidestep_axis_speed(state: MotionState, capabilities: &SelfMovementCapabilities) -> f32 {
    match (state.gait, state.sidestep) {
        (_, None) => 0.0,
        (Gait::Run, Some(_)) => {
            let anim_rate =
                (SIDESTEP_ADJUST_FACTOR * capabilities.run_rate_scalar).min(MAX_SIDESTEP_ANIM_RATE);
            SIDESTEP_ANIM_SPEED * anim_rate
        }
        (Gait::Walk, Some(_)) => SIDESTEP_ANIM_SPEED * SIDESTEP_ADJUST_FACTOR,
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
        // Backstep magnitude (walk-base × BackwardsFactor, run-scaled
        // for the Run gait) is computed in `forward_axis_speed`; here we
        // only flip the heading 180°. For the forward case the magnitude
        // is the resolved walk/run speed.
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

/// F1-3 (movement bughunt 2026-06-09): the raw wire turn speed is the
/// BASE scalar (1.0) for both gaits — ACE applies `RunTurnFactor` itself
/// from the already-sent `turn_hold_key = Run` (`adjust_motion →
/// apply_run_to_command`, `MotionInterp.cs:423-427,546-548`). The
/// previous gait-keyed 1.5 pre-multiplied the factor AND sent the Run
/// hold key, so the server/observers integrated stationary turns at
/// 2.25×. An explicit `state.turn_speed` override still passes through.
fn wire_turn_speed_for_state(state: MotionState) -> f32 {
    state.turn_speed.unwrap_or(WIRE_TURN_SPEED_BASE)
}

fn local_turn_omega(base_omega: Vector3, override_speed: Option<f32>, gait: Gait) -> Vector3 {
    match override_speed {
        Some(speed) => {
            let base_magnitude = base_omega.length();
            if base_magnitude > 0.0 {
                base_omega.normalize() * speed
            } else {
                Vector3::zero()
            }
        }
        // F1-3: apply retail's `RunTurnFactor` (1.5×) to the DAT base
        // omega while the Run key is held — the local predictor
        // previously turned at 1.0× in both gaits, 33% slower than
        // retail's run-held turn. Mirrors ACE `apply_run_to_command`'s
        // TurnRight arm (`MotionInterp.cs:546-548`), which the server
        // applies to our broadcast from the hold key; the local factor
        // keeps prediction in step with what observers integrate.
        None => match gait {
            Gait::Run => base_omega * RUN_TURN_FACTOR,
            Gait::Walk => base_omega,
        },
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
            state.gait,
        ),
        Some(Turn::Left) => local_turn_omega(
            capabilities.kinematics().base_turn_left_omega,
            state.turn_speed,
            state.gait,
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

        // Walk gait: the DAT base omega passes through unscaled.
        assert_eq!(
            local_omega_for_state(
                MotionState {
                    gait: Gait::Walk,
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

    /// F1-3 (movement bughunt 2026-06-09) — the Run gait applies retail's
    /// `RunTurnFactor` (1.5×) to the local turn omega. Previously the
    /// local predictor turned at 1.0× in both gaits (33% slower than
    /// retail's run-held turn) while the WIRE pre-multiplied 1.5 AND sent
    /// HoldKey=Run, making ACE apply the factor again (2.25× for
    /// observers). The factor now lives here, once.
    #[test]
    fn local_omega_for_state_applies_run_turn_factor() {
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
            Vector3::new(0.0, 0.0, -1.5 * RUN_TURN_FACTOR)
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
        // StrafeRight at heading 0 contributes (0.0, walk_strafe, 0.0) where
        // walk_strafe = SIDESTEP_ANIM_SPEED × SIDESTEP_ADJUST_FACTOR = 1.56
        // m/s (F1-2 retail magnitude — fixed, not derived from the walk base).
        // Both axes non-zero.
        let walk_strafe = SIDESTEP_ANIM_SPEED * SIDESTEP_ADJUST_FACTOR;
        assert!((velocity.x - (-1.0)).abs() < 1e-5);
        assert!((velocity.y - walk_strafe).abs() < 1e-5);
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

    /// F2-4 (movement bughunt 2026-06-09) — the turn fields are raw input
    /// state and are emitted INDEPENDENT of locomotion. The old Phase-2.4
    /// gate (turn only when stationary) starved observers of heading
    /// information while a player curved (W+Q/E): retail's
    /// `RawMotionState::ApplyMotion` writes the turn slot regardless of
    /// forward/sidestep, and ACE's broadcast converter handles TurnCommand
    /// ungated (`MovementData.cs:134-148`).
    #[test]
    fn build_motion_state_raw_motion_state_emits_turn_while_sidestep_active() {
        let world = holtburger_world::WorldState::synthetic();
        let state = MotionState::builder()
            .walk()
            .strafe_right()
            .turn_left()
            .build();

        let raw =
            build_motion_state_raw_motion_state(&world, state, MotionStyle::PreserveServer);

        assert!(raw.flags.contains(RawMotionFlags::SIDE_STEP_COMMAND));
        // F2-4: turn rides the wire alongside the strafe.
        assert!(raw.flags.contains(RawMotionFlags::TURN_COMMAND));
        assert_eq!(raw.turn_command, Some(TURN_RIGHT_MOTION_COMMAND));
        assert_eq!(raw.turn_speed, Some(-WIRE_TURN_SPEED_BASE));
    }

    /// F5-2/F2-1 (movement bughunt 2026-06-09) — the Run gait emits
    /// `WalkForward` + `HoldKey=Run` + speed 1.0 on the raw wire (retail's
    /// encoding). ACE's broadcast converter attaches `GetRunRate` ONLY in
    /// its WalkForward/WalkBackwards branch (`MovementData.cs:99-117`); the
    /// old raw-`RunForward` encoding fell through the `else` and observers
    /// received the runner at implicit speed 1.0 (base 4 m/s) with ~1 Hz
    /// rubber-band snaps.
    #[test]
    fn run_forward_emits_walk_forward_with_hold_key_run() {
        let world = holtburger_world::WorldState::synthetic();
        let state = MotionState::builder().run().forward().build();

        let raw =
            build_motion_state_raw_motion_state(&world, state, MotionStyle::PreserveServer);

        assert_eq!(
            raw.forward_command,
            Some(WALK_FORWARD_MOTION_COMMAND),
            "F5-2: raw wire must carry WalkForward; ACE canonicalizes to RunForward@GetRunRate",
        );
        // The interpreted-state RunForward code must never appear raw.
        assert_ne!(raw.forward_command, Some(0x4400_0007));
        assert_eq!(raw.forward_speed, Some(1.0));
        assert_eq!(raw.forward_hold_key, Some(HoldKey::Run as u32));
        assert_eq!(raw.current_hold_key, Some(HoldKey::Run as u32));
    }

    /// F1-2 (movement bughunt 2026-06-09) — retail strafe magnitudes:
    /// walk strafe `1.25 × 1.248 = 1.56 m/s`; run strafe anim-rate-capped
    /// at 3.0 then × 1.25 = `3.75 m/s` at high run rates.
    #[test]
    fn sidestep_axis_speeds_match_retail() {
        // Walk strafe: 1.56 m/s regardless of run rate.
        let caps_walk = retail_walk_base_capabilities(1.0);
        let walk_state = MotionState::builder().walk().strafe_right().build();
        let v = local_velocity_for_state(0.0, walk_state, &caps_walk);
        assert!(
            (v.length() - 1.56).abs() < 1e-4,
            "walk strafe expected 1.56 m/s, got {:.4}",
            v.length(),
        );

        // Run strafe below the clamp knee: 1.25 * 1.248 * run_rate.
        let caps_low = retail_walk_base_capabilities(2.0);
        let run_state = MotionState::builder().run().strafe_right().build();
        let v = local_velocity_for_state(0.0, run_state, &caps_low);
        let expected = 1.25 * (1.248_f32 * 2.0).min(3.0); // = 3.12
        assert!(
            (v.length() - expected).abs() < 1e-4,
            "run strafe @rr=2.0 expected {expected:.4} m/s, got {:.4}",
            v.length(),
        );

        // Run strafe at the maxed run rate: anim-rate clamps at 3.0 → 3.75 m/s.
        let caps_max = retail_walk_base_capabilities(4.5);
        let v = local_velocity_for_state(0.0, run_state, &caps_max);
        assert!(
            (v.length() - 3.75).abs() < 1e-4,
            "run strafe @rr=4.5 expected 3.75 m/s (anim-rate cap 3.0 × 1.25), got {:.4}",
            v.length(),
        );
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
            "Phase 2.5: Turn::Left collapses to TurnRight code (retail RAW-wire \
             convention for the turn field — ACE RawMotionState.cs:38-40)",
        );
        // F1-3: the wire turn speed is the BASE scalar (1.0) negated —
        // never the pre-multiplied run factor.
        assert_eq!(
            raw.turn_speed,
            Some(-WIRE_TURN_SPEED_BASE),
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
        assert_eq!(raw.turn_speed, Some(WIRE_TURN_SPEED_BASE));
    }

    /// F5-1 (movement bughunt 2026-06-09) — `SidestepLocomotion::StrafeLeft`
    /// emits the REAL `SideStepLeft (0x65000010)` enum with POSITIVE unit
    /// speed on the raw wire. ACE's broadcast converter derives the
    /// observers' direction ONLY from the raw enum
    /// (`MovementData.cs:123-131` — it never reads the raw speed's sign),
    /// so the old Phase-2.5 collapse (Right + negated speed) replicated a
    /// left-strafing player as strafing RIGHT to every observer. The
    /// Left→Right+negate rewrite belongs to the server's interpreted-state
    /// canonicalization, not the raw C2S layer.
    #[test]
    fn sidestep_left_emits_left_enum_with_positive_speed() {
        let world = holtburger_world::WorldState::synthetic();
        let state = MotionState::builder().walk().strafe_left().build();

        let raw =
            build_motion_state_raw_motion_state(&world, state, MotionStyle::PreserveServer);

        assert!(raw.flags.contains(RawMotionFlags::SIDE_STEP_COMMAND));
        assert_eq!(
            raw.sidestep_command,
            Some(SIDESTEP_LEFT_MOTION_COMMAND),
            "F5-1: the raw wire carries the real SideStepLeft enum",
        );
        assert_eq!(
            raw.sidestep_speed,
            Some(1.0),
            "F5-1: positive unit speed — direction rides the enum, not the sign",
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

    /// GAP 5 (2026-06-01) — backstep speed parity. Capabilities whose
    /// walk-forward base is the retail `WalkAnimSpeed = 3.12` m/s, so the
    /// backstep magnitude lands on the retail target `3.12 * 0.65 ≈ 2.03`
    /// m/s. (The shared `test_capabilities()` uses a walk base of `1.0`,
    /// which the other tests rely on; this helper isolates the retail
    /// number without disturbing them.)
    fn retail_walk_base_capabilities(run_rate_scalar: f32) -> SelfMovementCapabilities {
        SelfMovementCapabilities {
            kinematics: SelfMovementKinematics {
                source: PlayerMotionTableSource::DirectProperty {
                    motion_table_id: 0x0900_0001,
                },
                motion_table_id: 0x0900_0001,
                stance: MotionStance::NonCombat as u32,
                // Retail WalkAnimSpeed = 3.1199999 m/s.
                base_walk_forward_velocity: Vector3::new(0.0, 3.12, 0.0),
                base_run_forward_velocity: Vector3::new(0.0, 4.0, 0.0),
                base_turn_left_omega: Vector3::new(0.0, 0.0, -1.5),
                base_turn_right_omega: Vector3::new(0.0, 0.0, 1.5),
            },
            run_rate_scalar,
        }
    }

    /// GAP 5 — walk backstep is `WalkAnimSpeed * BackwardsFactor`
    /// (`3.12 * 0.65 ≈ 2.03` m/s), NOT the dimensionless `1.0` the
    /// pre-fix arm returned as raw m/s. Walk backstep is not run-scaled.
    #[test]
    fn walk_backstep_magnitude_is_walk_base_times_backwards_factor() {
        let capabilities = retail_walk_base_capabilities(1.0);
        let state = MotionState::builder().walk().backstep().build();

        let velocity = local_velocity_for_state(0.0, state, &capabilities);
        let expected = 3.12 * BACKWARDS_FACTOR; // ≈ 2.028
        assert!(
            (velocity.length() - expected).abs() < 1e-4,
            "walk backstep speed expected ≈ {expected:.4} m/s (3.12 * 0.65), got {:.4}",
            velocity.length(),
        );
    }

    /// GAP 5 — run backstep is the walk backstep magnitude additionally
    /// scaled by the `run_rate_scalar` (run_factor): `3.12 * 0.65 *
    /// run_factor`. The pre-fix arm returned the bare `run_rate_scalar`
    /// (~4.5) as raw m/s — both the constant and the scaling were wrong.
    #[test]
    fn run_backstep_magnitude_is_walk_backstep_times_run_factor() {
        let run_factor = 2.0;
        let capabilities = retail_walk_base_capabilities(run_factor);
        let state = MotionState::builder().run().backstep().build();

        let velocity = local_velocity_for_state(0.0, state, &capabilities);
        let expected = 3.12 * BACKWARDS_FACTOR * run_factor; // ≈ 2.028 * 2.0
        assert!(
            (velocity.length() - expected).abs() < 1e-4,
            "run backstep speed expected ≈ {expected:.4} m/s (3.12 * 0.65 * {run_factor}), got {:.4}",
            velocity.length(),
        );
    }

    // -----------------------------------------------------------------
    // Dimension 3 — grounded friction model (physics deep-dive
    // 2026-06-01). Unit-validation of `calc_friction` against ACE
    // `PhysicsObj.calc_friction` (`PhysicsObj.cs:2120-2141`).
    // -----------------------------------------------------------------

    const FLAT_NORMAL: Vector3 = Vector3 {
        x: 0.0,
        y: 0.0,
        z: 1.0,
    };

    /// On FLAT ground (`normal = (0,0,1)`) with the default `0.5`
    /// coefficient and sledding off, `calc_friction` must reproduce the
    /// prior scalar decay exactly: `v *= pow(1 - 0.5, quantum)` on X/Y,
    /// no Z introduced. This is the contract that the projection +
    /// sledding fidelity is a no-op on flat ground when the coefficient
    /// flag is off.
    #[test]
    fn calc_friction_flat_ground_matches_legacy_scalar_decay() {
        let quantum = 1.0 / 60.0;
        let mut v = Vector3::new(3.0, 1.0, 0.0);
        let mag2 = v.x * v.x + v.y * v.y;
        // velocity_mag2 = 10.0 — above SLEDDING_HIGH, but sledding is off
        // (and the flat normal would gate the steep-slope glide anyway).
        calc_friction(
            &mut v,
            FLAT_NORMAL,
            mag2,
            PLAYER_GROUND_FRICTION_PER_SEC,
            false,
            quantum,
        );
        let expected_scale = (1.0_f32 - PLAYER_GROUND_FRICTION_PER_SEC).powf(quantum);
        assert!((v.x - 3.0 * expected_scale).abs() < 1e-6, "x: {}", v.x);
        assert!((v.y - 1.0 * expected_scale).abs() < 1e-6, "y: {}", v.y);
        // Flat normal: no into-surface component, so no Z introduced.
        assert!(v.z.abs() < 1e-6, "z should stay 0 on flat ground, got {}", v.z);
    }

    /// The contact-plane projection must remove the into-surface velocity
    /// component on a SLOPE *before* damping. With a velocity that has a
    /// component pointing into the slope, the post-call velocity dotted
    /// with the normal must be ~0 up to the friction scale — i.e. the
    /// into-surface part is stripped, the in-plane part is only damped.
    #[test]
    fn calc_friction_projection_removes_into_surface_component_on_slope() {
        // A 30° slope facing +X: normal tilts toward +X.
        let normal = Vector3::new(0.5, 0.0, 0.866_025_4).normalize();
        // Velocity straight along +X (horizontal) has a component into
        // the slope: dot(v, normal) = 3.0 * 0.5 = 1.5 (> 0.25 cutoff?).
        // 1.5 >= 0.25 would early-return (moving away). Flip sign so the
        // velocity drives INTO the surface: -X moves down-into the slope.
        let mut v = Vector3::new(-3.0, 0.0, 0.0);
        let angle = v.dot(&normal); // = -1.5 (into surface, < 0.25)
        assert!(angle < FRICTION_AWAY_FROM_SURFACE_CUTOFF);
        let mag2 = v.length_squared();
        // Use friction = 0 so we can read the projection in isolation
        // (scale = pow(1,quantum) = 1).
        calc_friction(&mut v, normal, mag2, 0.0, false, 1.0 / 60.0);
        // After projection the velocity lies in the slope plane:
        // dot(v_proj, normal) == 0. Friction = 0 leaves it unscaled.
        let residual = v.dot(&normal);
        assert!(
            residual.abs() < 1e-5,
            "into-surface component should be removed: dot(v, n) = {residual}"
        );
    }

    /// `calc_friction` must EARLY-RETURN (no projection, no damping) when
    /// the velocity is separating from the surface faster than the
    /// `0.25` cutoff — `dot(v, normal) >= 0.25`. This mirrors ACE's
    /// `if (angle >= 0.25f) return;`.
    #[test]
    fn calc_friction_early_returns_when_moving_away_from_surface() {
        let normal = FLAT_NORMAL;
        // Upward velocity (away from a flat floor): dot = 0.5 >= 0.25.
        let mut v = Vector3::new(2.0, 0.0, 0.5);
        let before = v;
        let mag2 = v.length_squared();
        calc_friction(&mut v, normal, mag2, PLAYER_GROUND_FRICTION_PER_SEC, false, 1.0 / 60.0);
        assert_eq!(v.x, before.x, "no damping when separating");
        assert_eq!(v.y, before.y);
        assert_eq!(v.z, before.z);
    }

    /// SLEDDING low-speed override: on a near-flat slope with sledding
    /// engaged and `velocity_mag2 < 1.5625`, friction is forced to `1.0`
    /// → `scale = pow(0, quantum) = 0` → velocity stopped this quantum.
    #[test]
    fn calc_friction_sledding_low_velocity_forces_full_stop() {
        // velocity_mag2 = 1.0 < 1.5625.
        let mut v = Vector3::new(1.0, 0.0, 0.0);
        let mag2 = v.length_squared();
        assert!(mag2 < SLEDDING_LOW_VELOCITY_SQ);
        calc_friction(&mut v, FLAT_NORMAL, mag2, 0.5, true, 1.0 / 60.0);
        // friction := 1.0, scale = pow(0, q) = 0.
        assert!(v.x.abs() < 1e-6 && v.y.abs() < 1e-6, "sledding low: {v:?}");
    }

    /// SLEDDING high-speed override: on a STEEP slope
    /// (`normal.z < cos(10°) ≈ 0.98480775`) with sledding engaged and
    /// `velocity_mag2 >= 6.25`, friction stays at `0.2` (glide — the
    /// retail mountain-slide), NOT the passed-in coefficient
    /// (acclient.c:316124-316128: `frict` seeds 0.2 and only resets to
    /// object friction when slow OR `cos(10°) <= N.z`).
    #[test]
    fn calc_friction_sledding_high_velocity_glides_at_0_2_on_steep_slope() {
        // A real ramp normal (~23.6° slope — well below the cos(10°) cutoff).
        let normal = Vector3::new(0.4, 0.0, 0.916_515_1).normalize();
        assert!(normal.z < SLEDDING_STEEP_NORMAL_Z);
        // Velocity in the slope plane, high speed (mag2 >= 6.25):
        // along +Y, in-plane (n has no Y), into-surface dot < 0.25.
        let mut v = Vector3::new(0.0, 3.0, 0.0);
        let mag2 = v.length_squared();
        assert!(mag2 >= SLEDDING_HIGH_VELOCITY_SQ);
        let angle = v.dot(&normal);
        assert!(angle < FRICTION_AWAY_FROM_SURFACE_CUTOFF);
        // Pass coefficient 0.5; the steep-slope glide must keep 0.2.
        calc_friction(&mut v, normal, mag2, 0.5, true, 1.0 / 60.0);
        let expected_scale = (1.0_f32 - 0.2).powf(1.0 / 60.0);
        assert!(
            (v.y - 3.0 * expected_scale).abs() < 1e-6,
            "sledding fast on a steep slope should scale by pow(0.8, q): got {}",
            v.y
        );
    }

    /// SLEDDING high-speed override must NOT fire on flat/shallow ground:
    /// at high speed with `normal.z >= cos(10°)` the glide is gated off
    /// and the passed-in coefficient applies (acclient.c:316127
    /// `cos(0.1745329251994329) <= N.z` → object friction). This is the
    /// arm ACE inverted (`PhysicsObj.cs:2135` glides on dead-flat ground);
    /// retail glides on the STEEP slope instead.
    #[test]
    fn calc_friction_sledding_high_velocity_inactive_on_flat_ground() {
        let normal = Vector3::new(0.0, 0.0, 1.0);
        assert!(normal.z >= SLEDDING_STEEP_NORMAL_Z);
        let mut v = Vector3::new(3.0, 0.0, 0.0);
        let mag2 = v.length_squared();
        assert!(mag2 >= SLEDDING_HIGH_VELOCITY_SQ);
        calc_friction(&mut v, normal, mag2, 0.5, true, 1.0 / 60.0);
        // Flat ground: glide gated off → coefficient 0.5 applies (NOT 0.2).
        let expected_scale = (1.0_f32 - 0.5).powf(1.0 / 60.0);
        assert!(
            (v.x - 3.0 * expected_scale).abs() < 1e-5,
            "flat ground: should damp at 0.5 not 0.2, got {}",
            v.x
        );
        // A shallow (~5°) slope sits on the object-friction side too:
        // cos(5°) ≈ 0.9962 >= cos(10°).
        let shallow = Vector3::new(0.087_155_74, 0.0, 0.996_194_7).normalize();
        assert!(shallow.z >= SLEDDING_STEEP_NORMAL_Z);
        let mut v2 = Vector3::new(0.0, 3.0, 0.0);
        let mag2_2 = v2.length_squared();
        calc_friction(&mut v2, shallow, mag2_2, 0.5, true, 1.0 / 60.0);
        assert!(
            (v2.y - 3.0 * expected_scale).abs() < 1e-5,
            "shallow slope: should damp at 0.5 not 0.2, got {}",
            v2.y
        );
    }

    /// The retail coefficient constant is exactly ACE's
    /// `PhysicsGlobals.DefaultFriction = 0.95f`, and the default
    /// (flag-off) coefficient stays the hand-tuned `0.5`. Guards against
    /// an accidental constant swap.
    #[test]
    fn ground_friction_coefficients_are_pinned() {
        assert_eq!(PLAYER_GROUND_FRICTION_RETAIL, 0.95);
        assert_eq!(PLAYER_GROUND_FRICTION_PER_SEC, 0.5);
    }
}
