use super::common::{
    AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL, HUGE_QUANTUM, MAX_QUANTUM, MAX_VELOCITY, MIN_QUANTUM,
    PLAYER_GROUND_FRICTION_PER_SEC, PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ,
    PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC, build_autonomous_position,
    build_motion_state_raw_motion_state, encode_contact_long_jump,
    has_autonomous_position_sync_target, local_omega_for_state, local_velocity_for_state,
    normalize_heading, raw_motion_state_with_motion_style, signed_heading_delta,
};
use crate::client::movement_types::{
    AutonomousDriveIntent, ForwardLocomotion, MotionState, MotionStyle, MovementPacketMetadata,
    PlayerDriveIntent, Turn,
};
use anyhow::Result;
use holtburger_common::sequence::is_newer_u16;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::game_action::*;
use holtburger_protocol::messages::game_message::RawMotionState;
use holtburger_protocol::messages::movement::{InterpretedMotionCommand, MotionItem};
use holtburger_session::Session;
use holtburger_world::SolveBodyInput;
use holtburger_world::spatial::{LocalDriveControl, LocalDriveGait};
use holtburger_world::{SpatialBodyId, WorldEvent, WorldState};
use std::time::Duration;
use web_time::Instant;

/// Physics deep-dive 2026-06-01 (gaps 1 + 7) — gate for the
/// clamp-and-subdivide integration loop in
/// [`MovementSystem::advance_local_pose_for_manual_drive`].
///
/// `true` (default): bound the raw per-frame `dt`, drop a
/// `HUGE_QUANTUM`-or-larger hitch, and integrate the frame as a
/// sequence of `<= MAX_QUANTUM` slices with a terminal-velocity clamp
/// and 2nd-order airborne integration — mirroring ACE's
/// `update_object` (`PhysicsObj.cs:4140-4190`).
///
/// `false`: the legacy single-step path that consumes the raw,
/// unbounded `dt` in one symplectic-Euler integration. Retained for
/// A/B comparison; flip to `false` to reproduce the pre-2026-06-01
/// "frame-hitch over-integrates a fall" behaviour.
const USE_QUANTUM_SUBDIVIDED_INTEGRATION: bool = true;

/// Physics deep-dive 2026-06-01 (gap 3) — gate for step-up / step-down
/// in the lateral-clamp + floor-snap path of
/// [`MovementSystem::advance_local_pose_for_manual_drive_slice`].
///
/// `true` (default): when a grounded lateral move is blocked by a
/// riser within
/// [`holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT`], raise the
/// player onto it and let the move continue (curb / stair step); and
/// when the player walks off a drop, follow the surface down for drops
/// within [`holtburger_world::spatial::PLAYER_STEP_DOWN_HEIGHT`] instead
/// of falling at the legacy `LEDGE_FALL_THRESHOLD_M = 0.5` heuristic.
/// Mirrors ACE's `Transition.StepUp`/`StepDown` walkable path
/// (`Transition.cs:746-777,852-870`) capped at
/// `ObjectInfo.StepUpHeight`/`StepDownHeight`.
///
/// `false`: the pre-2026-06-01 behaviour — any riser blocks the move
/// (no step-up at all) and a descent beyond `0.5 m` falls. Retained
/// for A/B comparison.
const USE_STEP_UP_DOWN: bool = true;

/// Physics deep-dive 2026-06-01 (gap 4) — gate the AutonomousPosition
/// heartbeat on a position change instead of firing unconditionally.
///
/// `true` (default): the 1 s heartbeat (and the arrival sync) only
/// emit a packet when the pose has meaningfully changed since the last
/// one we sent — cell changed, origin/heading moved beyond
/// [`AUTONOMOUS_POSE_EPSILON_M`]/[`AUTONOMOUS_POSE_HEADING_EPSILON_RAD`],
/// or the contact byte flipped. Mirrors retail
/// `CommandInterpreter::ShouldSendPositionEvent`
/// (`acclient.c:718107-718141`): after the interval elapses it sends on
/// `objcell_id != last || !Frame::is_equal(...)`, and within the
/// interval on a cell or contact-plane change. Stops the heartbeat
/// re-asserting a stale/drifted pose every second.
///
/// `false`: the pre-2026-06-01 behaviour — fire every interval whenever
/// a sync target exists. Retained for A/B comparison.
const USE_AUTONOMOUS_POSITION_CHANGE_GATE: bool = true;

/// Physics deep-dive 2026-06-01 (gap 4) — "meaningfully changed"
/// thresholds for the heartbeat position-change gate. Retail's
/// `Frame::is_equal` is a bit-exact compare; we use small epsilons so
/// integrator round-off (and the per-tick terrain-Z snap) doesn't read
/// as a change and keep the heartbeat alive on a stationary player.
const AUTONOMOUS_POSE_EPSILON_M: f32 = 0.05;
const AUTONOMOUS_POSE_HEADING_EPSILON_RAD: f32 = 0.0035;

/// Physics deep-dive 2026-06-01 (gap 1) — bound + subdivide a raw
/// per-frame `dt` (seconds) into the integration-slice schedule,
/// mirroring ACE's `update_object` timestep gate
/// (`external/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:4140-4190`).
///
/// Returns:
/// - `None` when `dt > HUGE_QUANTUM` — the whole frame is dropped (no
///   integration), so a multi-second hitch can't teleport a falling
///   player. (`PhysicsObj.cs:4169-4173`.)
/// - `Some(slices)` otherwise — a list of slice durations, each
///   `<= MAX_QUANTUM`, summing to (almost) `dt`: the frame is split
///   into `MAX_QUANTUM` slices with the sub-`MAX_QUANTUM` remainder
///   appended only when it exceeds `MIN_QUANTUM` (ACE floors the
///   remainder at 1/30 s and drops anything smaller —
///   `PhysicsObj.cs:4175-4186`). A frame shorter than `MIN_QUANTUM`
///   yields an empty schedule (nothing integrated this frame),
///   matching retail's 30 Hz physics gate.
///
/// Single source of truth for both the production loop in
/// [`MovementSystem::advance_local_pose_for_manual_drive`] and the
/// subdivision-count unit tests.
fn quantum_slices(dt_secs: f32) -> Option<Vec<f32>> {
    if dt_secs > HUGE_QUANTUM {
        return None;
    }
    let mut slices = Vec::new();
    let mut remaining = dt_secs;
    while remaining > MAX_QUANTUM {
        slices.push(MAX_QUANTUM);
        remaining -= MAX_QUANTUM;
    }
    if remaining > MIN_QUANTUM {
        slices.push(remaining);
    }
    Some(slices)
}

#[derive(Debug, Default)]
struct MovementSequenceDiagnostics {
    last_force_position_sequence: Option<u16>,
    last_teleport_sequence: Option<u16>,
    last_server_control_sequence: Option<u16>,
}

impl MovementSequenceDiagnostics {
    fn record_force_position_sequence(&mut self, force_position_sequence: u16) {
        if let Some(old_seq) = self.last_force_position_sequence {
            if is_newer_u16(force_position_sequence, old_seq) {
                log::warn!(
                    "Server forced reposition (rubber band): force seq {} -> {}",
                    old_seq,
                    force_position_sequence
                );
            } else if force_position_sequence != old_seq {
                log::debug!(
                    "Ignoring stale forced reposition: force seq {} after {}",
                    force_position_sequence,
                    old_seq
                );
            }
        }

        self.last_force_position_sequence = Some(force_position_sequence);
    }

    fn record_autonomous_position_sequences(
        &mut self,
        teleport_sequence: u16,
        force_position_sequence: u16,
        server_control_sequence: u16,
    ) {
        match self.last_teleport_sequence {
            Some(old_seq) if is_newer_u16(teleport_sequence, old_seq) => {
                log::info!(
                    "Server-forced resync teleport epoch advanced: teleport seq {} -> {} (force seq {}, server-control seq {})",
                    old_seq,
                    teleport_sequence,
                    force_position_sequence,
                    server_control_sequence
                );
            }
            Some(old_seq) if teleport_sequence != old_seq => {
                log::debug!(
                    "Ignoring stale server-forced resync: teleport seq {} after {} (force seq {}, server-control seq {})",
                    teleport_sequence,
                    old_seq,
                    force_position_sequence,
                    server_control_sequence
                );
            }
            None => {
                log::info!(
                    "Tracking teleport sequence {} for autonomous resync (force seq {}, server-control seq {})",
                    teleport_sequence,
                    force_position_sequence,
                    server_control_sequence
                );
            }
            _ => {}
        }

        self.last_teleport_sequence = Some(teleport_sequence);
        self.last_force_position_sequence = Some(force_position_sequence);
        self.last_server_control_sequence = Some(server_control_sequence);
    }

    fn record_server_control_sequence(&mut self, server_control_sequence: u16) {
        match self.last_server_control_sequence {
            Some(old_seq) if is_newer_u16(server_control_sequence, old_seq) => {
                log::debug!(
                    "Server-controlled motion epoch advanced: {} -> {}",
                    old_seq,
                    server_control_sequence
                );
            }
            Some(old_seq) if server_control_sequence != old_seq => {
                log::warn!(
                    "Server-controlled motion reordered/stale: {} after {}",
                    server_control_sequence,
                    old_seq
                );
            }
            None => {
                log::debug!(
                    "Tracking server-controlled motion sequence: {}",
                    server_control_sequence
                );
            }
            _ => {}
        }

        self.last_server_control_sequence = Some(server_control_sequence);
    }
}

pub(crate) struct MovementSystem {
    sequence_diagnostics: MovementSequenceDiagnostics,
    queued_drive_commands: Vec<QueuedDriveCommand>,
    pending_transient_motion: Option<TransientMotionIntent>,
    pending_arrival_pose: Option<holtburger_common::position::WorldPosition>,
    pending_snap_facing: Option<f32>,
    active_drive: Option<ActiveDriveState>,
    server_motion_active: bool,
    last_server_motion_intent: Option<ServerMotionIntent>,
    suppress_frontend_autonomous_once: bool,
    server_controlled_projection: Option<ServerControlledProjection>,
    next_autonomous_position_heartbeat_at: Option<Instant>,
    /// Physics deep-dive 2026-06-01 (gap 4) — the pose + contact byte of
    /// the last AutonomousPosition packet we actually sent, used by the
    /// position-change gate (retail `last_sent_position` /
    /// `last_sent_contact_plane`). `None` until the first send.
    last_sent_autonomous_pose: Option<holtburger_common::position::WorldPosition>,
    last_sent_autonomous_contact: Option<u8>,
    /// Phase 4 step 3.6 diagnostic — incremented every time the
    /// autonomous-position heartbeat or arrival sync fires. The wasm
    /// bundle reads this via [`MovementSystemHandle::heartbeats_sent`]
    /// to verify the heartbeat actually emits packets (server-side
    /// position updates are async + flushed lazily, so client-side
    /// observability is essential for debugging).
    pub(crate) heartbeats_sent: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum QueuedDriveCommand {
    ManualSet(MotionState),
    ManualPulse {
        state: MotionState,
        duration: Duration,
    },
    Autonomous(AutonomousDriveIntent),
    Transient(TransientMotionIntent),
    ArriveAtPose {
        pose: holtburger_common::position::WorldPosition,
    },
    SnapFacing {
        heading: f32,
    },
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ActiveDriveIntent {
    Manual(MotionState),
    Autonomous(AutonomousDriveIntent),
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ActiveDriveState {
    intent: ActiveDriveIntent,
    until: Option<Instant>,
}

impl ActiveDriveState {
    fn manual(state: MotionState, until: Option<Instant>) -> Self {
        Self {
            intent: ActiveDriveIntent::Manual(state),
            until,
        }
    }

    fn autonomous(intent: AutonomousDriveIntent) -> Self {
        Self {
            intent: ActiveDriveIntent::Autonomous(intent),
            until: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ServerMotionIntent {
    state: MotionState,
    motion_style: MotionStyle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TransientMotionIntent {
    command: InterpretedMotionCommand,
    motion_style: MotionStyle,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ServerControlledProjection {
    pub target_pose: holtburger_common::position::WorldPosition,
    pub speed_mps: f32,
}

fn server_motion_intent(state: MotionState, motion_style: MotionStyle) -> ServerMotionIntent {
    ServerMotionIntent {
        state,
        motion_style,
    }
}

impl MovementSystem {
    pub(crate) fn new() -> Self {
        Self {
            sequence_diagnostics: MovementSequenceDiagnostics::default(),
            queued_drive_commands: Vec::new(),
            pending_transient_motion: None,
            pending_arrival_pose: None,
            pending_snap_facing: None,
            active_drive: None,
            server_motion_active: false,
            last_server_motion_intent: None,
            suppress_frontend_autonomous_once: false,
            server_controlled_projection: None,
            next_autonomous_position_heartbeat_at: None,
            last_sent_autonomous_pose: None,
            last_sent_autonomous_contact: None,
            heartbeats_sent: 0,
        }
    }

    pub(crate) fn note_server_controlled_movement_started(&mut self) {
        self.suppress_frontend_autonomous_once = true;
    }

    pub(crate) fn set_server_controlled_projection(
        &mut self,
        projection: ServerControlledProjection,
    ) {
        self.server_controlled_projection = Some(projection);
    }

    pub(crate) fn clear_server_controlled_projection(&mut self) {
        self.server_controlled_projection = None;
    }

    fn clear_autonomous_position_heartbeat_schedule(&mut self) {
        self.next_autonomous_position_heartbeat_at = None;
    }

    pub(crate) fn arm_autonomous_position_heartbeat_schedule(
        &mut self,
        now: Instant,
        world: &WorldState,
    ) {
        self.refresh_autonomous_position_heartbeat_schedule(now, world);
    }

    fn refresh_autonomous_position_heartbeat_schedule(&mut self, now: Instant, world: &WorldState) {
        self.next_autonomous_position_heartbeat_at = has_autonomous_position_sync_target(world)
            .then_some(now + AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL);
    }

    pub(crate) fn enqueue_drive_intent(&mut self, intent: PlayerDriveIntent, now: Instant) {
        let _ = now;
        let command = match intent {
            PlayerDriveIntent::ManualHeld(state) => QueuedDriveCommand::ManualSet(state),
            PlayerDriveIntent::ManualPulse { state, duration } => {
                QueuedDriveCommand::ManualPulse { state, duration }
            }
            PlayerDriveIntent::Autonomous(intent) => QueuedDriveCommand::Autonomous(intent),
            PlayerDriveIntent::ArriveAtPose { pose } => QueuedDriveCommand::ArriveAtPose { pose },
            PlayerDriveIntent::SnapFacing { heading } => QueuedDriveCommand::SnapFacing { heading },
            PlayerDriveIntent::Stop => QueuedDriveCommand::Stop,
        };

        self.queued_drive_commands.push(command);
    }

    pub(crate) fn enqueue_transient_motion(
        &mut self,
        command: InterpretedMotionCommand,
        motion_style: MotionStyle,
    ) {
        self.queued_drive_commands
            .push(QueuedDriveCommand::Transient(TransientMotionIntent {
                command,
                motion_style,
            }));
    }

    fn ingest_drive_command(&mut self, command: QueuedDriveCommand, now: Instant) {
        match command {
            QueuedDriveCommand::ManualSet(state) => {
                self.active_drive = Some(ActiveDriveState::manual(state, None));
            }
            QueuedDriveCommand::ManualPulse { state, duration } => {
                self.active_drive = Some(ActiveDriveState::manual(state, Some(now + duration)));
            }
            QueuedDriveCommand::Autonomous(intent) => {
                self.active_drive = Some(ActiveDriveState::autonomous(intent));
            }
            QueuedDriveCommand::Transient(intent) => {
                self.pending_transient_motion = Some(intent);
            }
            QueuedDriveCommand::ArriveAtPose { pose } => {
                self.pending_arrival_pose = Some(pose);
                self.active_drive = None;
            }
            QueuedDriveCommand::SnapFacing { heading } => {
                self.pending_snap_facing = Some(heading);
            }
            QueuedDriveCommand::Stop => {
                self.pending_arrival_pose = None;
                self.pending_snap_facing = None;
                self.active_drive = None;
            }
        }
    }

    fn expire_active_drive(&mut self, now: Instant) {
        if self
            .active_drive
            .is_some_and(|active| matches!(active.intent, ActiveDriveIntent::Autonomous(_)))
        {
            self.active_drive = None;
        }

        let Some(active) = self.active_drive else {
            return;
        };

        if active.until.is_some_and(|until| now >= until) {
            log::info!(
                "movement: expiring active drive {:?} at tick {:?}",
                active.intent,
                now,
            );
            self.active_drive = None;
        }
    }

    fn autonomous_wire_motion_state(
        world: &WorldState,
        intent: AutonomousDriveIntent,
    ) -> Option<MotionState> {
        let current_heading = world
            .local_player_runtime_pose()
            .unwrap_or_default()
            .rotation
            .to_heading();
        let planar_delta = Vector3::new(
            intent.desired_world_delta.x,
            intent.desired_world_delta.y,
            0.0,
        );
        // Wave 2 Phase 2.2 (2026-05-26): autonomous drives still emit pure
        // forward locomotion — the autonomous pathfinder consumes
        // `desired_world_delta` as a single vector and only needs to
        // signal "moving forward" vs "turning in place" to observers.
        // The diagonal-composition gain applies to manual input only; if
        // an autonomous routine later needs strafe semantics it can
        // populate `state.sidestep` directly.
        let forward =
            (planar_delta.length_squared() > 1e-6).then_some(ForwardLocomotion::Forward);
        let desired_heading = intent.desired_heading.map(normalize_heading).or_else(|| {
            (planar_delta.length_squared() > 1e-6)
                .then(|| Vector3::zero().heading_to(&planar_delta))
        });
        let turning = if forward.is_some() {
            None
        } else {
            desired_heading.and_then(|desired_heading| {
                let delta = signed_heading_delta(current_heading, desired_heading);
                if delta.abs() <= 1e-4 {
                    None
                } else if delta > 0.0 {
                    Some(Turn::Right)
                } else {
                    Some(Turn::Left)
                }
            })
        };

        if forward.is_none() && turning.is_none() {
            return None;
        }

        // The shared solver owns local realization, but ACE still needs a
        // MoveToState edge so observers receive motion-state broadcasts.
        Some(MotionState {
            gait: intent.gait,
            forward,
            sidestep: None,
            turning,
            turn_speed: None,
        })
    }

    pub(crate) async fn tick(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        session: &mut Session,
    ) -> Result<Vec<WorldEvent>> {
        self.reconcile_server_controlled_projection(world);

        let had_active_manual_motion = matches!(
            self.active_drive,
            Some(ActiveDriveState {
                intent: ActiveDriveIntent::Manual(_),
                ..
            })
        );

        self.expire_active_drive(now);

        let queued = std::mem::take(&mut self.queued_drive_commands);
        if !queued.is_empty() {
            log::info!(
                "movement: ingesting {} queued drive commands at tick {:?}: {:?}",
                queued.len(),
                now,
                queued,
            );
        }
        let explicit_stop_requested = queued
            .iter()
            .any(|command| matches!(command, QueuedDriveCommand::Stop));
        for command in queued {
            self.ingest_drive_command(command, now);
        }

        if self.suppress_frontend_autonomous_once
            && matches!(
                self.active_drive,
                Some(ActiveDriveState {
                    intent: ActiveDriveIntent::Autonomous(_),
                    ..
                })
            )
        {
            log::info!(
                "movement: suppressing frontend autonomous wire motion during server-controlled movement"
            );
            self.active_drive = None;
        }
        self.suppress_frontend_autonomous_once = false;

        let mut events = Vec::new();
        if let Some(pose) = self.pending_arrival_pose.take() {
            events.extend(
                self.execute_arrival_pose(
                    now,
                    pose,
                    world,
                    session,
                    MovementPacketMetadata::default(),
                )
                .await?,
            );
        }
        if let Some(heading) = self.pending_snap_facing.take() {
            events.extend(
                self.execute_snap_facing(
                    now,
                    heading,
                    world,
                    session,
                    MovementPacketMetadata::default(),
                )
                .await?,
            );
        }

        let transient_sent = if let Some(intent) = self.pending_transient_motion.take() {
            self.execute_transient_motion_at(intent, world, session)
                .await?;
            true
        } else {
            false
        };

        if !transient_sent {
            match self.active_drive.map(|active| active.intent) {
                Some(ActiveDriveIntent::Manual(state)) => events.extend(
                    self.execute_motion_state_at(state, world, session, now)
                        .await?,
                ),
                Some(ActiveDriveIntent::Autonomous(intent)) => events.extend(
                    self.execute_autonomous_drive_intent(intent, world, session, now)
                        .await?,
                ),
                None if had_active_manual_motion || explicit_stop_requested => {
                    events.extend(
                        self.execute_stop_at(
                            now,
                            world,
                            session,
                            MovementPacketMetadata::default(),
                            had_active_manual_motion || explicit_stop_requested,
                        )
                        .await?,
                    );
                }
                None => {}
            }
        }

        let _ = self
            .maybe_send_autonomous_position_heartbeat(
                now,
                world,
                session,
                MovementPacketMetadata::default(),
            )
            .await?;

        Ok(events)
    }

    pub(crate) fn current_local_drive_control(
        &self,
        world: &WorldState,
        dt: Duration,
    ) -> Option<LocalDriveControl> {
        if world.player.guid == Guid::NULL {
            return None;
        }

        let body_id = SpatialBodyId::LocalPlayer(world.player.guid);

        if let Some(projection) = self.server_controlled_projection {
            let current_pose = world.local_player_runtime_pose().unwrap_or_default();
            let to_target = projection.target_pose.global_coords() - current_pose.global_coords();
            let max_step = (projection.speed_mps.max(0.1) * dt.as_secs_f32().max(0.001)).max(0.05);
            let desired_world_delta = if to_target.length_squared() <= 1e-6 {
                Vector3::zero()
            } else {
                let distance = to_target.length();
                if distance <= max_step {
                    to_target
                } else {
                    to_target.normalize() * max_step
                }
            };

            let desired_heading = if desired_world_delta.length_squared() > 1e-6 {
                Some(current_pose.heading_to(&projection.target_pose))
            } else {
                Some(projection.target_pose.rotation.to_heading())
            };

            return Some(LocalDriveControl {
                body_id,
                desired_world_delta,
                desired_heading,
                target_hint: Some(projection.target_pose),
                gait: if projection.speed_mps > 1.0 {
                    LocalDriveGait::Run
                } else {
                    LocalDriveGait::Walk
                },
                force_grounded: true,
            });
        }

        let intent = match self.active_drive?.intent {
            ActiveDriveIntent::Autonomous(intent) => intent,
            ActiveDriveIntent::Manual(_) => return None,
        };

        Some(LocalDriveControl {
            body_id,
            desired_world_delta: intent.desired_world_delta,
            desired_heading: intent.desired_heading,
            target_hint: intent.target_hint,
            gait: match intent.gait {
                crate::client::movement_types::Gait::Walk => LocalDriveGait::Walk,
                crate::client::movement_types::Gait::Run => LocalDriveGait::Run,
            },
            force_grounded: intent.force_grounded,
        })
    }

    /// Phase 4 step 3.6 — advance the local-player runtime pose by
    /// `velocity * dt` if the active drive is `Manual`. The cli's
    /// full flow runs this implicitly via `simulation::tick` →
    /// `current_local_solve_body_input` → `SpatialPhysics::solve` →
    /// `apply_solved_body_kinematics`. The wasm bundle skips the
    /// solver to keep the bundle small; this thin integrator is just
    /// enough to keep the WorldState pose advancing so
    /// `AutonomousPosition` heartbeats carry a current position.
    /// No-op when active drive is None / Autonomous (Autonomous
    /// already gets its delta via `current_local_drive_control`).
    ///
    /// Physics deep-dive 2026-06-01 (gaps 1 + 7): this is the
    /// clamp-and-subdivide entry point. The raw per-frame `dt` is
    /// bounded and split into `<= MAX_QUANTUM` slices before being
    /// fed to [`advance_local_pose_for_manual_drive_slice`], mirroring
    /// ACE's `update_object` timestep gate
    /// (`external/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:4140-4190`).
    /// Gravity, friction (`pow(1-f, q)` composes correctly per-slice),
    /// the terminal-velocity clamp, and collision all run per slice,
    /// so a frame-hitch can no longer over-integrate a fall in one
    /// giant step. Gated behind
    /// [`USE_QUANTUM_SUBDIVIDED_INTEGRATION`] (default on); when off,
    /// the old single-step path is preserved for A/B.
    pub(crate) fn advance_local_pose_for_manual_drive(
        &self,
        world: &mut WorldState,
        dt: Duration,
    ) {
        if !USE_QUANTUM_SUBDIVIDED_INTEGRATION {
            // Legacy single-step path (pre-2026-06-01). Retained
            // behind the flag for A/B comparison of the subdivided
            // loop. Consumes the raw, unbounded `dt` in one step.
            self.advance_local_pose_for_manual_drive_slice(world, dt);
            return;
        }

        // Accumulate the incoming frame time with any sub-MIN_QUANTUM
        // tail carried from prior frames. Mirrors ACE's `update_object`
        // measuring `deltaTime = CurrentTime - UpdateTime` and only
        // advancing `UpdateTime` by the *consumed* time
        // (`PhysicsObj.cs:4159-4188`) — so a stream of 60 Hz (16 ms)
        // frames accumulates here until it crosses MIN_QUANTUM and a
        // slice is integrated, matching retail's 30 Hz physics gate.
        let total = world.player.physics_time_accumulator + dt.as_secs_f32();

        // `quantum_slices` returns `None` when the accumulated time is
        // a HugeQuantum hitch (dropped, no integration; the consumed
        // time is reset below so a multi-second stall can't replay) and
        // otherwise the bounded `<= MAX_QUANTUM` slice schedule. Each
        // slice runs the full gravity / friction / collision
        // integration so the per-slice motion is bounded and a
        // frame-hitch can no longer over-integrate a fall in one step.
        let Some(slices) = quantum_slices(total) else {
            // HugeQuantum: consume the time without integrating
            // (`PhysicsObj.cs:4169-4173` sets `UpdateTime = CurrentTime`).
            world.player.physics_time_accumulator = 0.0;
            return;
        };
        let consumed: f32 = slices.iter().sum();
        for quantum in slices {
            self.advance_local_pose_for_manual_drive_slice(world, Duration::from_secs_f32(quantum));
        }
        // Carry the sub-MIN_QUANTUM tail to the next frame. ACE leaves
        // this remainder in the timer (`UpdateTime` advanced only by
        // the integrated slices).
        world.player.physics_time_accumulator = (total - consumed).max(0.0);
    }

    /// One bounded integration slice (`quantum <= MAX_QUANTUM`).
    /// Factored out of [`advance_local_pose_for_manual_drive`] by the
    /// physics deep-dive 2026-06-01 quantum-subdivision work; the
    /// caller bounds and subdivides the incoming frame `dt` and feeds
    /// each slice here. The body is the original per-frame integrator
    /// (friction smoothing, lateral collision clamp, airborne gravity
    /// arc, floor-Z snap, rotation prediction) advanced by exactly one
    /// quantum.
    fn advance_local_pose_for_manual_drive_slice(
        &self,
        world: &mut WorldState,
        dt: Duration,
    ) {
        let Some(active) = self.active_drive else {
            return;
        };
        let ActiveDriveIntent::Manual(state) = active.intent else {
            return;
        };
        let Some(mut pose) = world.local_player_runtime_pose() else {
            return;
        };
        let heading = pose.rotation.to_heading();
        let capabilities = match world.resolve_self_movement_capabilities() {
            Ok(c) => c,
            Err(_) => return,
        };
        let target_velocity = local_velocity_for_state(heading, state, &capabilities);
        // Phase 2 (Cohere-D, 2026-05-12): also compute angular velocity
        // from the manual drive state so we can apply local rotation
        // prediction below. Prior to this, the manual integrator only
        // updated `pose.coords` — `pose.rotation` was left server-
        // authoritative, so Q/E felt dead until the next
        // `UpdateMotion` broadcast roundtrip (50-200 ms latency).
        // Mirrors how the 2D path's per-rAF prediction tick locally
        // integrates heading at `index.html:6388-6395`.
        let omega = local_omega_for_state(state, &capabilities);
        let dt_s = dt.as_secs_f32();

        // Wave 10 Phase 10.3 (2026-05-26): friction-decay + accel-cap
        // velocity smoothing.
        //
        // Prior waves used `target_velocity` directly for the per-tick
        // delta — input changes flipped the velocity vector instantly.
        // The smell-test scenario (jump backwards, hold W on touchdown)
        // teleported the player's lateral velocity from -backward to
        // +forward in a single tick, which read as a visual snap.
        //
        // The retail behaviour, per `CPhysicsObj::calc_friction` at
        // `external/GDL/PhatSDK/PhysicsObj.cpp:521-561`, is a per-tick
        // multiplicative decay on `m_velocityVector` gated by
        // `transient_state & ON_WALKABLE_TS` (`PhysicsObj.cpp:523`).
        // Acceleration is applied separately via `m_Acceleration` in
        // `UpdatePhysicsInternal` (`PhysicsObj.cpp:594-598`). We don't
        // port the full retail pipeline (the `apply_raw_movement` chain
        // sets `m_velocityVector` to the input target directly, then
        // friction-decays it); instead we approximate the
        // smoothing-toward-target with a per-axis accel cap and a
        // gentler friction coefficient
        // (`PLAYER_GROUND_FRICTION_PER_SEC = 0.5` in
        // `movement/common.rs`, vs retail's 0.95) so the accel cap can
        // hold the smoothed velocity within a small percent of the
        // input target at steady state.
        //
        // The Z axis is NOT touched here — `vertical_velocity` is
        // managed separately by the jump/fall arcs (see lines
        // 841-848). We only smooth X/Y.
        //
        // When airborne, friction is skipped (matches retail's
        // ON_WALKABLE_TS gate) and the input-derived `target_velocity`
        // is applied directly. This lets a player who jumps mid-stride
        // keep their forward momentum in the air, and lets a jump-
        // backwards player flip direction in flight by holding W (with
        // no friction to lag against — instant input response is fine
        // mid-air since the rig is already in the airborne pose).
        let smoothed_planar = if world.player.is_airborne {
            // Airborne — pass the target through. The lateral velocity
            // store stays in sync so a touchdown lands with the right
            // initial velocity for friction-decay to act on.
            let v = Vector3::new(target_velocity.x, target_velocity.y, 0.0);
            world.player.current_planar_velocity = v;
            v
        } else {
            // Grounded: apply friction decay + accel cap, then snap to
            // zero below the small-velocity threshold.
            let mut v = world.player.current_planar_velocity;
            // Per-tick friction scale = `(1 - F)^dt`. Matches PhatSDK
            // `pow(1.0 - the_friction, quantum)` exactly.
            let scale = (1.0 - PLAYER_GROUND_FRICTION_PER_SEC).powf(dt_s);
            v.x *= scale;
            v.y *= scale;
            // Move toward target with per-axis accel cap. Retail has no
            // explicit cap (uses friction-only smoothing); this is a
            // game-feel addition to make direction changes ramp through
            // zero. The user flagged this constant as "tune-later".
            let accel_step = PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ * dt_s;
            for (cur, tgt) in [
                (&mut v.x, target_velocity.x),
                (&mut v.y, target_velocity.y),
            ] {
                let delta = tgt - *cur;
                let clamped = delta.clamp(-accel_step, accel_step);
                *cur += clamped;
            }
            // small-velocity snap (PhysicsObj.cpp:589-592).
            let mag_sq = v.x * v.x + v.y * v.y;
            let threshold_sq = PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC
                * PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC;
            // The snap fires only when both the target and the current
            // velocity are below the threshold — otherwise the player
            // is actively accelerating from rest, and snapping would
            // kill the ramp-up. This matches the spirit of retail's
            // gate (`velocity_mag2 < small_velocity^2`): the player
            // has stopped requesting movement, so kill residual drift.
            let target_mag_sq =
                target_velocity.x * target_velocity.x + target_velocity.y * target_velocity.y;
            if mag_sq < threshold_sq && target_mag_sq < threshold_sq {
                v.x = 0.0;
                v.y = 0.0;
            }
            world.player.current_planar_velocity = v;
            v
        };

        // Build the world-space delta. X/Y come from the smoothed
        // velocity; Z still flows from `target_velocity.z` so the
        // existing airborne integrator below can override with the
        // gravity arc when `is_airborne`.
        let raw_delta = Vector3::new(
            smoothed_planar.x * dt_s,
            smoothed_planar.y * dt_s,
            target_velocity.z * dt_s,
        );
        // Lateral (X/Y) clamp. Two paths:
        //   - Outdoor: Phase 6 step B sweep-sphere against the
        //     per-cell `building_aabb_index`. Z stays raw so the
        //     terrain-Z snap below can do its job.
        //   - Indoor:  Phase 6 follow-on (academy rubberband fix,
        //     2026-05-10) — clamp the proposed lateral motion to the
        //     interior of the player's current EnvCell's world-space
        //     AABB (already populated by Phase 6D). Without this the
        //     player walks straight through dungeon walls because
        //     `building_aabb_index` is outdoor-only; the divergence
        //     between the client's predicted pose and ACE's
        //     authoritative cell-bounded pose is what surfaces as
        //     visible rubberbanding. Falls back to no-clamp when the
        //     cell hasn't been baked yet (lazy `fetchEnvCellsInLand-
        //     block` path) or the player has drifted outside every
        //     cell — in the latter case the next server `Update-
        //     Position` will snap them back inside, after which this
        //     clamp engages and keeps them there.
        // Pre-bake gate: indoor cell whose physics_polygons +
        // cell AABB haven't been baked yet. Detected once so the
        // lateral clamp, the Z delta, and the floor-Z snap all
        // agree to leave `pose` exactly where the server seeded
        // it. The first frame after `[phase6.G] drained …` flips
        // this false and full prediction engages.
        let indoor_unbaked = if pose.is_indoors() {
            let cell_id = world.scene.current_cell(&pose);
            world.scene.cell_triangles(cell_id).is_empty()
                && world.scene.cell_aabb(cell_id).is_none()
        } else {
            false
        };
        let lateral = Vector3::new(raw_delta.x, raw_delta.y, 0.0);
        let lateral_clamped = if pose.is_indoors() {
            // 2026-05-10 indoor collision: prefer per-polygon
            // wall-clamp against the cell's `physics_polygons`
            // (Phase 6 step G) when triangles are loaded; fall back
            // to the cell-AABB containment clamp when they aren't.
            // The per-poly clamp handles non-rectangular cells
            // (L-shapes, corridors with bends, doorways) accurately;
            // the AABB clamp is the safety net while the lazy
            // physics-bake catches up after a landblock entry.
            //
            // Pre-bake gate (academy rubberband fix follow-on
            // 2026-05-10): when neither the cell AABB nor any
            // physics triangles have been loaded yet — typical for
            // the first few seconds after entity seed before
            // `fetchEnvCellsInLandblock` finishes its async bake —
            // refuse to predict any indoor motion. Without this,
            // the integrator runs unclamped, the heartbeat ships
            // positions ACE rejects, and the resulting force-
            // reposition snaps the player back to spawn (the
            // "moves a little, snaps back" symptom). With this
            // gate, the heartbeat keeps repeating the last server-
            // confirmed pose until the bake completes; rotation
            // flow is unaffected since rotation flows through
            // `UpdateMotion` (server-driven), not this integrator.
            let cell_id = world.scene.current_cell(&pose);
            let triangles = world.scene.cell_triangles(cell_id);
            let cell_aabb_opt = world.scene.cell_aabb(cell_id);
            // PR-RR 2026-05-23: open-door exclusion list — cell-mesh
            // sweeps skip triangles whose centroid sits inside any of
            // these. Lets the player walk through doors whose collision
            // panel is part of the EnvCell BSP (the common indoor
            // case). Empty when no doors are open near the player; the
            // sweep no-ops on empty exclusion via the existing
            // `exclusion_aabbs.is_empty()` short-circuit.
            let exclusion_aabbs =
                world.scene.open_door_exclusion_aabbs_near(&pose);
            if triangles.is_empty() && cell_aabb_opt.is_none() {
                Vector3::zero()
            } else {
                let pre_clamped = if !triangles.is_empty() {
                    holtburger_world::spatial::clamp_delta_against_cell_walls_with_exclusions(
                        triangles,
                        &pose,
                        lateral,
                        holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                        holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT,
                        &exclusion_aabbs,
                    )
                } else {
                    lateral
                };
                // Always also apply the AABB containment clamp as a
                // safety net — even with per-poly walls, an L-shaped
                // cell whose wall triangles are missing on one segment
                // could let the player drift out of the AABB. Cheap
                // and idempotent on top of per-poly.
                //
                // PR-RR.1 2026-05-23: bypass the safety net when an
                // open door is within range — the cell AABB stops at
                // the doorway, so containment clamp crops the player's
                // delta right at the door even with the panel polys
                // already excluded. Per-poly walls + door-entity
                // ETHEREAL filter are sufficient inside the doorway
                // (any nearby wall triangle would have caught us in
                // the prior pass). Trade-off: temporarily disables the
                // L-shaped-cell drift defence when standing next to
                // an open door — acceptable for the door-walk-through
                // UX. Proper fix is a multi-cell containment variant
                // that consults the portal graph (see
                // docs/FOLLOW_ONS.md "Cell-AABB containment vs.
                // doorway crossing").
                match cell_aabb_opt {
                    Some(aabb) if exclusion_aabbs.is_empty() => {
                        holtburger_world::spatial::clamp_delta_to_cell_interior(
                            &pose,
                            pre_clamped,
                            &aabb,
                            holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                        )
                    }
                    _ => pre_clamped,
                }
            }
        } else {
            let candidates = world.scene.building_aabbs_near_pose(&pose);
            if candidates.is_empty() {
                lateral
            } else {
                holtburger_world::spatial::clamp_delta_against_buildings(
                    &candidates,
                    &pose,
                    lateral,
                    holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                )
            }
        };
        // Entity collision pass. Mirrors ACE's
        // `PhysicsObj.find_object_collisions`
        // (`Source/ACE.Server/Physics/PhysicsObj.cs:~410`), which
        // tests the moving object against every nearby world object
        // and branches on `PhysicsState::HAS_PHYSICS_BSP` to pick
        // BSP-polygon vs cylsphere collision. We only do the
        // cylsphere fallback today; the BSP path is wired through
        // `EntityCollider::has_physics_bsp` and is a follow-on.
        //
        // Filtering rules (caller-side, before reaching the math):
        //   - Skip the local player itself.
        //   - Skip `!Entity::is_collidable()` (entities with
        //     `ETHEREAL` like open doors, or `IGNORE_COLLISIONS`).
        //   - Spatial pre-filter: only consider entities within
        //     `lateral.length() + (combined radii)` so we don't pay
        //     the swept-circle math for entities we can't possibly
        //     reach this tick.
        //
        // Per-entity radius: looked up from the SetupModel
        // cyl-sphere cache (`WorldState::setup_radii`, populated
        // wasm-side by the SetupModel loader). Misses fall back to
        // the player capsule radius — a reasonable default for
        // humanoid-scale entities whose SetupModel hasn't been
        // loaded yet. Mirrors ACE's `PhysicsObj.GetPhysicsRadius` at
        // `Source/ACE.Server/Physics/PhysicsObj.cs:~590`.
        let lateral_clamped = {
            let self_guid = world.player.guid;
            let player_global = pose.global_coords();
            let player_radius = holtburger_world::spatial::PLAYER_CAPSULE_RADIUS;
            // Conservative pre-filter radius — assume the largest
            // reasonable entity is ~2m wide (a small giant) so we
            // don't miss large creatures. Tighter pre-filter would
            // need to inspect each entity's resolved radius first,
            // which is the work we're trying to avoid for far-away
            // candidates.
            let prefilter_dist = lateral_clamped.length() + player_radius + 2.0;
            let prefilter_sq = prefilter_dist * prefilter_dist;
            let colliders: Vec<_> = world
                .entities
                .iter()
                .filter(|e| e.guid != self_guid && e.is_collidable())
                .filter_map(|e| {
                    let g = e.position.global_coords();
                    let dx = g.x - player_global.x;
                    let dy = g.y - player_global.y;
                    if dx * dx + dy * dy >= prefilter_sq {
                        return None;
                    }
                    Some(holtburger_world::spatial::EntityCollider {
                        center_xy: (g.x, g.y),
                        radius: world.entity_collision_radius(e),
                        has_physics_bsp: e.has_physics_bsp(),
                    })
                })
                .collect();
            if colliders.is_empty() {
                lateral_clamped
            } else {
                holtburger_world::spatial::clamp_delta_against_entities(
                    &colliders,
                    &pose,
                    lateral_clamped,
                    player_radius,
                )
            }
        };
        // Physics deep-dive 2026-06-01 (gap 3) — step-UP. When the
        // lateral clamp shortened the requested move (a wall/riser
        // blocked us) and we're grounded, probe the floor at the
        // *intended* (un-clamped) destination. If a walkable floor
        // sits there within `PLAYER_STEP_UP_HEIGHT` of the feet, climb
        // onto it (raise Z) and take the full lateral move instead of
        // stopping dead — retail's `Transition.StepUp`
        // (`Transition.cs:746-777`, capped at `ObjectInfo.StepUpHeight`).
        // Risers taller than the step-up height stay blocked.
        //
        // Skipped while airborne (climbing is a ground action; the
        // jump/fall arc owns Z), while the indoor cell is unbaked (no
        // floor source), and when the gate is off.
        if USE_STEP_UP_DOWN
            && !world.player.is_airborne
            && !indoor_unbaked
            && lateral.length_squared() > 1e-10
        {
            // "Blocked": the clamp removed a meaningful slice of the
            // requested lateral travel. A tiny shortfall is just the
            // slide/backoff jitter, not a wall, so require a clear gap
            // (10% of the requested length, floor 1 cm) before we
            // treat it as a step-up candidate.
            let requested_len = lateral.length();
            let clamped_len = lateral_clamped.length();
            let blocked_gap = requested_len - clamped_len;
            let blocked = blocked_gap > (requested_len * 0.1).max(0.01);
            if blocked {
                // Intended (un-clamped) destination pose for the floor
                // probe — where the player WANTED to be this tick.
                let intended = holtburger_common::position::WorldPosition {
                    landblock_id: pose.landblock_id,
                    coords: Vector3::new(
                        pose.coords.x - lateral_clamped.x + lateral.x,
                        pose.coords.y - lateral_clamped.y + lateral.y,
                        pose.coords.z,
                    ),
                    rotation: pose.rotation,
                };
                let dest_global = intended.global_coords();
                let feet_z = pose.coords.z;
                // Floor at the intended destination, indoor vs outdoor.
                let dest_floor_z: Option<f32> = if intended.is_indoors() {
                    let cell_id = world.scene.current_cell(&intended);
                    let triangles = world.scene.cell_triangles(cell_id);
                    let cell_aabb = world.scene.cell_aabb(cell_id);
                    // Cap the floor query a step-up above the feet so a
                    // distant high floor (e.g. an upper landing reached
                    // by a separate ramp) doesn't masquerade as a step.
                    let ceiling = feet_z + holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT;
                    if !triangles.is_empty() {
                        holtburger_world::spatial::highest_floor_z_under(
                            triangles,
                            dest_global.x,
                            dest_global.y,
                            ceiling,
                        )
                    } else {
                        // No triangles yet — the AABB floor is the only
                        // source, and it's flat, so there's no riser to
                        // step onto. Leave step-up to the per-poly path.
                        let _ = cell_aabb;
                        None
                    }
                } else {
                    world.terrain_height_at(dest_global.x, dest_global.y)
                };
                if let Some(new_feet_z) = holtburger_world::spatial::step_up_decision(
                    blocked,
                    feet_z,
                    dest_floor_z,
                    holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT,
                ) {
                    // Climb: take the full intended lateral move and
                    // raise the feet onto the riser top. The floor-Z
                    // snap below keeps us seated once we're up there.
                    pose.coords.x = intended.coords.x;
                    pose.coords.y = intended.coords.y;
                    pose.coords.z = new_feet_z;
                } else {
                    pose.coords.x += lateral_clamped.x;
                    pose.coords.y += lateral_clamped.y;
                }
            } else {
                pose.coords.x += lateral_clamped.x;
                pose.coords.y += lateral_clamped.y;
            }
        } else {
            pose.coords.x += lateral_clamped.x;
            pose.coords.y += lateral_clamped.y;
        }
        // TODO (physics deep-dive 2026-06-01, gap 3 follow-up):
        // edge_slide / cliff_slide. When a step-up is refused (the
        // riser is too tall) or the player walks off a non-walkable
        // cliff edge, retail slides along the contact-plane via a
        // cross-product skid rather than stopping dead
        // (`Transition.StepUpSlide` + the `AllowEdgeSlide` /
        // `PhysicsState::EDGE_SLIDE` 0x00400000 gate, parsed at
        // `object.rs:78` and never consulted). Deferred here — it needs
        // the contact-plane cross-product skid, which is a larger
        // change to the single-iteration slide. Not implemented in this
        // pass.
        //
        // Pre-bake gate: zero Z delta when the indoor cell is
        // unbaked, same rationale as the lateral zero above —
        // sending an uncorrected Z drift would let ACE force-
        // reposition us back to spawn.
        //
        // Airborne integration. When `world.player.is_airborne`,
        // the player is in mid-jump or mid-fall: integrate gravity
        // into the vertical velocity and add the displacement to
        // pose.z. Mirrors ACE's airborne `UpdatePhysicsInternal`.
        // While airborne the per-tick floor snap below treats the
        // floor as a *landing trigger* rather than a clamp, so the
        // jump arc plays out cleanly.
        //
        // Physics deep-dive 2026-06-01 (gap 7): 2nd-order integration.
        // Gravity is carried as an acceleration (`az = -9.8`,
        // consistent with ACE `calc_acceleration` setting
        // `Acceleration.z = -9.8` under the GRAVITY state flag,
        // `PhysicsObj.cs:2079-2080`). The position uses the OLD
        // velocity plus the half-step `0.5 * az * q^2`, THEN the
        // velocity is updated by `az * q` — matching ACE's
        // `movement = Acceleration*0.5*q*q + Velocity*q;
        // Velocity += Acceleration*q` (`PhysicsObj.cs:1854-1858`).
        // This restores the missing `0.5*a*t^2` term the old
        // first-order symplectic-Euler step dropped.
        //
        // `9.8 m/s²` matches ACE's `MovementSystem.GetJumpHeight`
        // kinematic (`v = sqrt(h * 19.6)` ⇒ `g = 9.8`).
        if !indoor_unbaked {
            if world.player.is_airborne {
                // Acceleration-carried gravity (downward).
                let az = -9.8_f32;
                let v_old = world.player.vertical_velocity;
                // Position from OLD velocity + half-step.
                pose.coords.z += v_old * dt_s + 0.5 * az * dt_s * dt_s;
                // Then advance velocity by a*q.
                let v_new = v_old + az * dt_s;
                // Terminal-velocity clamp (gap 1 / gap 7): bound the
                // total velocity magnitude to MAX_VELOCITY so a long
                // fall does not accelerate unbounded. Mirrors ACE's
                // per-quantum clamp inside `UpdatePhysicsInternal`
                // (`Velocity = Normalize(Velocity) * MaxVelocity`,
                // `PhysicsObj.cs:1843-1846`). Retail clamps the WHOLE
                // velocity vector, so we scale the airborne planar
                // store and the vertical velocity by the same factor
                // — keeping the resulting magnitude exactly
                // MAX_VELOCITY and the direction unchanged.
                let mut vx = world.player.current_planar_velocity.x;
                let mut vy = world.player.current_planar_velocity.y;
                let mut vz = v_new;
                let speed_sq = vx * vx + vy * vy + vz * vz;
                if speed_sq > MAX_VELOCITY * MAX_VELOCITY {
                    let scale = MAX_VELOCITY / speed_sq.sqrt();
                    vx *= scale;
                    vy *= scale;
                    vz *= scale;
                    world.player.current_planar_velocity.x = vx;
                    world.player.current_planar_velocity.y = vy;
                }
                world.player.vertical_velocity = vz;
            } else {
                pose.coords.z += raw_delta.z;
            }
        }
        // Floor-Z snap. Two paths:
        //   - Outdoor: bilinear-interp the cached 9×9 terrain
        //     heightmap. Without this the integrator's Z stays at the
        //     teleport-landing value (vz==0 for forward locomotion),
        //     ACE's FastTick (Player_Tick.cs:154 `IsPKType` gate)
        //     reads the client as floating above ground, applies
        //     gravity → fall damage on landing.
        //   - Indoor:  Phase 6 follow-on — snap to `cell_aabb.min.z`
        //     plus a 5 mm headroom (matches the AC convention; ACE
        //     log shows persisted indoor positions at z=0.005). Also
        //     clamp from above so a long jump doesn't punch through
        //     the cell ceiling. This is a coarser proxy than a
        //     swept-triangle test against `physics_polygons` — for a
        //     ramped floor the player visually pops to the cell's
        //     lowest point, but it's enough to stop the rubberband.
        //
        // The outdoor heightmap cache is pre-populated for the 9-LB
        // spawn neighbourhood at `kind=7 EnteredWorld` (see
        // `SessionHandle::populate_terrain`). When it misses
        // (player wandered past the prefetched window) we preserve
        // the existing Z; ACE will apply false gravity in that
        // narrow band but the typical play loop hits the fast path.
        if !pose.is_indoors() {
            let global = pose.global_coords();
            if let Some(z) = world.terrain_height_at(global.x, global.y) {
                if world.player.is_airborne {
                    // Airborne outdoor: snap only on landing (falling
                    // through the terrain plane). The terrain Z is the
                    // canonical floor — when ballistic integration
                    // takes us below it with downward velocity, that's
                    // the touchdown.
                    if world.player.vertical_velocity <= 0.0 && pose.coords.z <= z {
                        pose.coords.z = z;
                        world.player.land();
                    }
                } else {
                    // Wave 5 Phase 5.1 (movement-animation overhaul,
                    // 2026-05-26): walked-off-ledge detection. When the
                    // grounded player's lateral step takes them onto a
                    // terrain cell whose height is significantly below
                    // their current Z, the prior unconditional snap
                    // (`pose.coords.z = z`) teleported them down to the
                    // new terrain — no fall, no animation, no Z arc.
                    // This is the bug the Wave 1 audit called out: the
                    // deleted airborne tween was the only visual cue
                    // for falling, so a walk-off now produces a
                    // T-pose-into-teleport-down.
                    //
                    // Fix: if the step down exceeds the ledge-fall
                    // threshold (treats a normal slope walk / curb as
                    // not a fall), transition the player to airborne via
                    // [`PlayerState::begin_fall`] and DON'T snap Z this
                    // tick — let the gravity integrator on the next
                    // tick handle the drop. The recv loop's
                    // `was_airborne_pre_tick && !is_airborne` landing
                    // diff above + the new walk-off→airborne diff
                    // below produce the right wire-side motion
                    // emissions (`Falling` → `Land`/`Fallen`).
                    //
                    // Physics deep-dive 2026-06-01 (gap 3) — step-DOWN.
                    // When `USE_STEP_UP_DOWN` is set, the threshold is
                    // the per-object `PLAYER_STEP_DOWN_HEIGHT` (1.5 m
                    // for the human body, from Setup `0x0200_0001`):
                    // drops within it snap the feet down to follow the
                    // surface (curbs, short steps), drops beyond it are
                    // real ledges and fall — mirroring ACE's
                    // `Transition` `StepDown` path capped at
                    // `ObjectInfo.StepDownHeight` (`Transition.cs:855`).
                    //
                    // When the gate is off, fall back to the legacy
                    // `LEDGE_FALL_THRESHOLD_M = 0.5` heuristic. That
                    // value was tuned for AC terrain: the heightmap
                    // resolution is 24 m sample spacing with bilinear
                    // interp, so the largest legitimate single-step
                    // descent is ≈0.5 m for the steepest 26° slope
                    // walking forward at 4 m/s @ 60 Hz. Outdoor cliff
                    // edges in Holtburg surrounds typically drop 2-10 m,
                    // so either threshold flags a genuine ledge.
                    const LEDGE_FALL_THRESHOLD_M: f32 = 0.5;
                    if USE_STEP_UP_DOWN {
                        match holtburger_world::spatial::step_down_decision(
                            pose.coords.z,
                            z,
                            holtburger_world::spatial::PLAYER_STEP_DOWN_HEIGHT,
                        ) {
                            holtburger_world::spatial::StepDownOutcome::Snap(snap_z) => {
                                pose.coords.z = snap_z;
                            }
                            holtburger_world::spatial::StepDownOutcome::Fall => {
                                world.player.begin_fall();
                                // Leave Z alone — gravity drops us next tick.
                            }
                        }
                    } else if pose.coords.z - z > LEDGE_FALL_THRESHOLD_M {
                        world.player.begin_fall();
                        // Leave Z alone — let the gravity integrator
                        // drop us next tick.
                    } else {
                        pose.coords.z = z;
                    }
                }
            }
        } else if indoor_unbaked {
            // Pre-bake gate: skip floor-Z snap entirely. Without
            // a baked AABB or triangles there's no source of
            // floor-Z, and any computed snap would either no-op
            // (ok) or use stale data (not ok).
        } else {
            // 2026-05-10 indoor floor-Z: prefer per-polygon raycast
            // (`highest_floor_z_under`) when the cell's
            // `physics_polygons` are loaded — handles stairs and
            // ramps accurately. Fall back to `cell_aabb.min.z` when
            // they aren't (initial seconds after landblock entry,
            // before the lazy physics bake completes), so the
            // player still has a floor to stand on.
            let cell_id = world.scene.current_cell(&pose);
            let global = pose.global_coords();
            let triangles = world.scene.cell_triangles(cell_id);
            let cell_aabb = world.scene.cell_aabb(cell_id);
            // Pick a generous "ceiling" Z for the floor query so a
            // player jumping or perched on stairs still finds a
            // floor below them. The cell's max.z is a natural cap;
            // when no AABB is registered, use a far-future value so
            // the raycast doesn't artificially exclude high stairs.
            let ceiling_for_floor_query = cell_aabb
                .map(|a| a.max.z + 1.0)
                .unwrap_or(pose.coords.z + 100.0);
            let floor_z = if !triangles.is_empty() {
                holtburger_world::spatial::highest_floor_z_under(
                    triangles,
                    global.x,
                    global.y,
                    ceiling_for_floor_query,
                )
                .or_else(|| cell_aabb.map(|a| a.min.z))
            } else {
                cell_aabb.map(|a| a.min.z)
            };
            if let Some(floor) = floor_z {
                let snap_z = floor + 0.005; // 5 mm headroom; matches AC
                if pose.coords.z < snap_z {
                    pose.coords.z = snap_z;
                    // Indoor landing: snap-up triggered while airborne
                    // → touchdown. Outdoor analog above uses
                    // `world.player.land()` likewise.
                    if world.player.is_airborne {
                        world.player.land();
                    }
                }
            }
            // Ceiling clamp — protect against the player being
            // shoved through the ceiling by a tall jump or a server
            // forced reposition. Uses cell AABB max.z; per-poly
            // ceiling raycast is left for a future commit (rare in
            // practice — AC ceilings are usually higher than the
            // player ever reaches in a normal walk).
            if let Some(aabb) = cell_aabb {
                let ceiling_z =
                    aabb.max.z - holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT;
                let floor_min = floor_z.unwrap_or(aabb.min.z + 0.005);
                if pose.coords.z > ceiling_z {
                    pose.coords.z = ceiling_z.max(floor_min);
                }
            }
        }
        // Phase 2 (Cohere-D, 2026-05-12): apply local rotation
        // prediction so Q/E feels responsive without waiting for the
        // server's UpdateMotion broadcast roundtrip. `omega.z` is the
        // yaw rate (rad/s) from `local_omega_for_state` —
        // `base_turn_right_omega = (0, 0, +1.5)` for Run, scaled by
        // any `turn_speed` override on the MotionState. Server still
        // owns the canonical heading (UpdateMotion overrides this
        // when it arrives); the local update is purely a "show the
        // user something now" prediction. No-op when the player
        // isn't turning (omega.z near zero), matching the existing
        // forward/strafe path that no-ops on zero velocity.
        if omega.z.abs() > f32::EPSILON {
            let new_heading = normalize_heading(heading + omega.z * dt_s);
            pose.rotation = Quaternion::from_heading(new_heading);
        }

        // Phase 4 step 3.7 — re-bucket coords if we crossed a 192 m
        // landblock boundary. Without this, the AutonomousPosition
        // packet reports e.g. (94, 200, 94) inside the seeded
        // landblock_id when the player has actually walked into the
        // adjacent landblock — ACE rubber-bands or silently rejects.
        let pose = pose.rebucket_outdoor_landblock();
        let _ = world.set_local_player_runtime_pose(pose);
    }

    pub(crate) fn current_local_solve_body_input(
        &self,
        world: &WorldState,
    ) -> Option<SolveBodyInput> {
        let guid = world.player.guid;
        if guid == Guid::NULL {
            return None;
        }

        if world.scene.body(SpatialBodyId::LocalPlayer(guid)).is_none()
            && world.player_landblock().is_none()
        {
            return None;
        }

        let body_id = SpatialBodyId::LocalPlayer(guid);
        let pose = world.local_player_runtime_pose()?;
        let (velocity, omega) = match self.active_drive.map(|active| active.intent) {
            Some(ActiveDriveIntent::Manual(state)) => {
                let heading = pose.rotation.to_heading();
                match world.resolve_self_movement_capabilities() {
                    Ok(capabilities) => (
                        local_velocity_for_state(heading, state, &capabilities),
                        local_omega_for_state(state, &capabilities),
                    ),
                    Err(error) => {
                        log::warn!(
                            "manual local solve missing self-movement capabilities: {error}"
                        );
                        (Vector3::zero(), Vector3::zero())
                    }
                }
            }
            _ => (Vector3::zero(), Vector3::zero()),
        };

        Some(SolveBodyInput::velocity(
            body_id,
            pose,
            world
                .runtime_body_view(body_id)
                .map(|body| body.contact)
                .unwrap_or(holtburger_world::ContactState::Unknown),
            velocity,
            omega,
        ))
    }

    fn reconcile_server_controlled_projection(&mut self, world: &WorldState) {
        let Some(projection) = self.server_controlled_projection else {
            return;
        };
        let Some(current_pose) = world.local_player_runtime_pose() else {
            return;
        };

        if current_pose.landblock_id != projection.target_pose.landblock_id {
            return;
        }

        if current_pose.distance_to(&projection.target_pose) <= 0.05 {
            log::info!(
                "movement: completed server-controlled projection at {:?}",
                projection.target_pose
            );
            self.server_controlled_projection = None;
        }
    }

    pub(crate) fn record_force_position_sequence(&mut self, force_position_sequence: u16) {
        self.sequence_diagnostics
            .record_force_position_sequence(force_position_sequence);
    }

    pub(crate) fn record_autonomous_position_sequences(
        &mut self,
        teleport_sequence: u16,
        force_position_sequence: u16,
        server_control_sequence: u16,
    ) {
        self.sequence_diagnostics
            .record_autonomous_position_sequences(
                teleport_sequence,
                force_position_sequence,
                server_control_sequence,
            );
    }

    pub(crate) fn record_server_control_sequence(&mut self, server_control_sequence: u16) {
        self.sequence_diagnostics
            .record_server_control_sequence(server_control_sequence);
    }

    fn should_send_stop_pulse(&self) -> bool {
        self.server_motion_active
    }

    fn note_server_motion_sent(&mut self, intent: ServerMotionIntent) {
        self.server_motion_active = true;
        self.last_server_motion_intent = Some(intent);
    }

    fn note_transient_motion_sent(&mut self) {
        self.server_motion_active = true;
        self.last_server_motion_intent = None;
    }

    fn note_server_motion_cleared(&mut self) {
        self.server_motion_active = false;
        self.last_server_motion_intent = None;
    }

    async fn execute_motion_state_at(
        &mut self,
        state: MotionState,
        world: &mut WorldState,
        session: &mut Session,
        now: Instant,
    ) -> Result<Vec<WorldEvent>> {
        self.execute_motion_state_with_metadata_at(
            state,
            MovementPacketMetadata::default(),
            world,
            session,
            now,
        )
        .await
    }

    async fn execute_stop_at(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        session: &mut Session,
        metadata: MovementPacketMetadata,
        had_active_local_motion: bool,
    ) -> Result<Vec<WorldEvent>> {
        let state_events = Vec::new();

        if self.should_send_stop_pulse() {
            log::info!(
                "movement: sending stop pulse (had_active_local_motion={}, server_motion_active={})",
                had_active_local_motion,
                self.server_motion_active,
            );
            Self::send_stop_pulse(world, session, metadata).await?;
            if had_active_local_motion {
                self.send_autonomous_position_sync(now, world, session, metadata)
                    .await?;
            }
            self.note_server_motion_cleared();
        }

        Ok(state_events)
    }

    async fn execute_motion_state_with_metadata_at(
        &mut self,
        state: MotionState,
        metadata: MovementPacketMetadata,
        world: &mut WorldState,
        session: &mut Session,
        _now: Instant,
    ) -> Result<Vec<WorldEvent>> {
        let state_events = Vec::new();

        if self.should_send_motion_state_pulse(state, metadata.motion_style) {
            log::info!("movement: sending resolved motion pulse state={:?}", state);
            Self::send_motion_state_pulse(world, session, state, metadata).await?;
            self.note_server_motion_sent(server_motion_intent(state, metadata.motion_style));
        }

        Ok(state_events)
    }

    async fn execute_transient_motion_at(
        &mut self,
        intent: TransientMotionIntent,
        world: &mut WorldState,
        session: &mut Session,
    ) -> Result<()> {
        let movement_sequence = world.player.next_move_seq();
        let raw_motion_state = raw_motion_state_with_motion_style(
            world,
            RawMotionState {
                commands: vec![MotionItem::new(
                    intent.command,
                    movement_sequence,
                    true,
                    1.0,
                )],
                ..Default::default()
            },
            intent.motion_style,
        );
        Self::send_transient_motion_pulse(world, session, raw_motion_state).await?;
        self.note_transient_motion_sent();
        Ok(())
    }

    async fn execute_snap_facing(
        &mut self,
        now: Instant,
        desired_heading: f32,
        world: &mut WorldState,
        session: &mut Session,
        metadata: MovementPacketMetadata,
    ) -> Result<Vec<WorldEvent>> {
        let normalized_heading = normalize_heading(desired_heading);
        let Some(current_pose) = world.local_player_runtime_pose() else {
            return Ok(Vec::new());
        };
        let current_heading = current_pose.rotation.to_heading();

        log::info!(
            "movement: snap facing from {:.3} rad to {:.3} rad",
            current_heading,
            normalized_heading,
        );

        if signed_heading_delta(current_heading, normalized_heading).abs() <= 1e-4 {
            return Ok(Vec::new());
        }

        let mut next_pos = current_pose;
        next_pos.rotation = Quaternion::from_heading(normalized_heading);
        let world_events = world.set_local_player_runtime_pose(next_pos);

        self.send_autonomous_position_sync(now, world, session, metadata)
            .await?;

        Ok(world_events)
    }

    async fn execute_arrival_pose(
        &mut self,
        now: Instant,
        pose: holtburger_common::position::WorldPosition,
        world: &mut WorldState,
        session: &mut Session,
        metadata: MovementPacketMetadata,
    ) -> Result<Vec<WorldEvent>> {
        log::info!("movement: applying arrival pose {:?}", pose);

        let world_events = world.set_local_player_runtime_pose(pose);
        self.send_autonomous_position_sync(now, world, session, metadata)
            .await?;

        Self::send_stop_pulse(world, session, metadata).await?;
        self.note_server_motion_cleared();

        Ok(world_events)
    }

    async fn execute_autonomous_drive_intent(
        &mut self,
        intent: AutonomousDriveIntent,
        world: &mut WorldState,
        session: &mut Session,
        now: Instant,
    ) -> Result<Vec<WorldEvent>> {
        let world_events = Vec::new();

        if let Some(state) = Self::autonomous_wire_motion_state(world, intent) {
            self.execute_motion_state_with_metadata_at(
                state,
                MovementPacketMetadata::default(),
                world,
                session,
                now,
            )
            .await?;

            return Ok(world_events);
        }

        if self.should_send_stop_pulse() {
            self.execute_stop_at(
                now,
                world,
                session,
                MovementPacketMetadata::default(),
                false,
            )
            .await?;
        }

        Ok(world_events)
    }

    /// Physics deep-dive 2026-06-01 (gap 4) — retail
    /// `CommandInterpreter::ShouldSendPositionEvent`
    /// (`acclient.c:718107-718141`) port for the heartbeat gate. Returns
    /// `true` when the pulse differs from the last one we sent: cell
    /// (landblock/objcell) changed, origin/heading moved beyond the pose
    /// epsilons, or the contact byte flipped (the contact-plane-change
    /// sub-branch). The first send (no prior pose) always passes.
    fn autonomous_pose_changed(&self, pulse: &AutonomousPositionActionData) -> bool {
        if !USE_AUTONOMOUS_POSITION_CHANGE_GATE {
            return true;
        }

        let Some(last_pose) = self.last_sent_autonomous_pose else {
            return true;
        };

        // Cell / landblock change (`objcell_id != last`).
        if pulse.position.landblock_id != last_pose.landblock_id {
            return true;
        }

        // Origin change (`!Frame::is_equal` — origin component). Same
        // landblock here, so a plain coords distance is the offset.
        if pulse.position.coords.distance(&last_pose.coords) > AUTONOMOUS_POSE_EPSILON_M {
            return true;
        }

        // Heading change (`!Frame::is_equal` — orientation component).
        let heading_delta = signed_heading_delta(
            last_pose.rotation.to_heading(),
            pulse.position.rotation.to_heading(),
        );
        if heading_delta.abs() > AUTONOMOUS_POSE_HEADING_EPSILON_RAD {
            return true;
        }

        // Contact-plane change (the sub-interval branch). We don't carry
        // a full plane, but the wire `last_contact` byte (grounded vs
        // airborne) is the contact signal the server consumes; re-send
        // when it flips even if the pose is otherwise unchanged.
        if self.last_sent_autonomous_contact != Some(pulse.last_contact) {
            return true;
        }

        false
    }

    /// Record the pose + contact we just put on the wire so the next
    /// [`Self::autonomous_pose_changed`] compares against it.
    fn note_autonomous_position_sent(&mut self, pulse: &AutonomousPositionActionData) {
        self.last_sent_autonomous_pose = Some(pulse.position);
        self.last_sent_autonomous_contact = Some(pulse.last_contact);
    }

    async fn maybe_send_autonomous_position_heartbeat(
        &mut self,
        now: Instant,
        world: &WorldState,
        session: &mut Session,
        metadata: MovementPacketMetadata,
    ) -> Result<bool> {
        let Some(next_heartbeat_at) = self.next_autonomous_position_heartbeat_at else {
            if has_autonomous_position_sync_target(world) {
                self.next_autonomous_position_heartbeat_at =
                    Some(now + AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL);
            }
            return Ok(false);
        };

        if now < next_heartbeat_at {
            return Ok(false);
        }

        // The heartbeat used to be gated on `IsPKType` (FastTick) because
        // our integrator emitted constant-Z poses that ACE physics
        // (`Player_Move.cs::HandleFallingDamage`) interpreted as the
        // player floating above terrain → applied false gravity →
        // impact damage on landing → death walking 10 s after a
        // Holtburg teleport (live-test reproduction 2026-05-08 against
        // tailnet1's Tester with PK status: "5 points of crushing
        // impact damage" → "10 points of massive impact damage" →
        // "You died!").
        //
        // The integrator now snaps pose Z to the cached terrain
        // heightmap before write-back (see
        // `advance_local_pose_for_manual_drive` + the
        // `WorldState::populate_terrain_heights` /
        // `terrain_height_at` cache), so the heartbeat carries a Z
        // that matches ACE's terrain. PK and NPK both fire the
        // heartbeat as before; the gate is no longer needed.

        let Some(pulse) = build_autonomous_position(world, metadata) else {
            self.clear_autonomous_position_heartbeat_schedule();
            return Ok(false);
        };

        // Physics deep-dive 2026-06-01 (gap 4): position-change gate.
        // Skip the send when the pose hasn't meaningfully changed since
        // the last packet (retail `ShouldSendPositionEvent`) so we don't
        // re-assert a stale/drifted pose every second. The heartbeat
        // schedule still advances — we just stay quiet until movement
        // (or a contact flip) produces something worth sending.
        if !self.autonomous_pose_changed(&pulse) {
            if has_autonomous_position_sync_target(world) {
                self.refresh_autonomous_position_heartbeat_schedule(now, world);
            } else {
                self.clear_autonomous_position_heartbeat_schedule();
            }
            return Ok(false);
        }

        session
            .send_action(GameAction::AutonomousPosition(Box::new(pulse.clone())))
            .await?;
        self.heartbeats_sent = self.heartbeats_sent.wrapping_add(1);
        self.note_autonomous_position_sent(&pulse);

        if has_autonomous_position_sync_target(world) {
            self.refresh_autonomous_position_heartbeat_schedule(now, world);
        } else {
            self.clear_autonomous_position_heartbeat_schedule();
        }

        Ok(true)
    }

    pub(crate) async fn send_autonomous_position_sync(
        &mut self,
        now: Instant,
        world: &WorldState,
        session: &mut Session,
        metadata: MovementPacketMetadata,
    ) -> Result<bool> {
        let Some(pulse) = build_autonomous_position(world, metadata) else {
            self.clear_autonomous_position_heartbeat_schedule();
            return Ok(false);
        };

        // This is an explicit flush (arrival / drive sync), not the
        // throttled heartbeat — always send. Record the sent pose so
        // the next heartbeat's position-change gate compares against it.
        session
            .send_action(GameAction::AutonomousPosition(Box::new(pulse.clone())))
            .await?;
        self.note_autonomous_position_sent(&pulse);

        self.refresh_autonomous_position_heartbeat_schedule(now, world);

        Ok(true)
    }

    fn should_send_motion_state_pulse(
        &self,
        state: MotionState,
        motion_style: MotionStyle,
    ) -> bool {
        if !self.server_motion_active {
            return true;
        }

        self.last_server_motion_intent != Some(server_motion_intent(state, motion_style))
    }

    async fn send_motion_state_pulse(
        world: &WorldState,
        session: &mut Session,
        state: MotionState,
        metadata: MovementPacketMetadata,
    ) -> Result<()> {
        let data = holtburger_protocol::messages::game_action::MoveToStateActionData {
            raw_motion_state: build_motion_state_raw_motion_state(
                world,
                state,
                metadata.motion_style,
            ),
            position: world.local_player_runtime_pose().unwrap_or_default(),
            instance_sequence: world.player.instance_sequence,
            server_control_sequence: world.player.server_control_sequence,
            teleport_sequence: world.player.teleport_sequence,
            force_position_sequence: world.player.force_position_sequence,
            contact_long_jump: encode_contact_long_jump(world, metadata),
        };

        session
            .send_action(GameAction::MoveToState(Box::new(data)))
            .await
    }

    async fn send_transient_motion_pulse(
        world: &WorldState,
        session: &mut Session,
        raw_motion_state: RawMotionState,
    ) -> Result<()> {
        let data = MoveToStateActionData {
            raw_motion_state,
            position: world.local_player_runtime_pose().unwrap_or_default(),
            instance_sequence: world.player.instance_sequence,
            server_control_sequence: world.player.server_control_sequence,
            teleport_sequence: world.player.teleport_sequence,
            force_position_sequence: world.player.force_position_sequence,
            contact_long_jump: encode_contact_long_jump(world, MovementPacketMetadata::default()),
        };

        session
            .send_action(GameAction::MoveToState(Box::new(data)))
            .await
    }

    async fn send_stop_pulse(
        world: &WorldState,
        session: &mut Session,
        metadata: MovementPacketMetadata,
    ) -> Result<()> {
        let data = holtburger_protocol::messages::game_action::MoveToStateActionData {
            raw_motion_state: raw_motion_state_with_motion_style(
                world,
                RawMotionState::default(),
                metadata.motion_style,
            ),
            position: world.local_player_runtime_pose().unwrap_or_default(),
            instance_sequence: world.player.instance_sequence,
            server_control_sequence: world.player.server_control_sequence,
            teleport_sequence: world.player.teleport_sequence,
            force_position_sequence: world.player.force_position_sequence,
            contact_long_jump: encode_contact_long_jump(world, metadata),
        };

        session
            .send_action(GameAction::MoveToState(Box::new(data)))
            .await
    }
}

#[cfg(test)]
mod tests;
