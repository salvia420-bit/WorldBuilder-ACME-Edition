use super::common::{
    AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL, build_autonomous_position,
    build_motion_state_raw_motion_state, encode_contact_long_jump,
    has_autonomous_position_sync_target, local_omega_for_state, local_velocity_for_state,
    normalize_heading, raw_motion_state_with_motion_style, signed_heading_delta,
};
use crate::client::movement_types::{
    AutonomousDriveIntent, Locomotion, MotionState, MotionStyle, MovementPacketMetadata,
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
        let locomotion = (planar_delta.length_squared() > 1e-6).then_some(Locomotion::Forward);
        let desired_heading = intent.desired_heading.map(normalize_heading).or_else(|| {
            (planar_delta.length_squared() > 1e-6)
                .then(|| Vector3::zero().heading_to(&planar_delta))
        });
        let turning = if locomotion.is_some() {
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

        if locomotion.is_none() && turning.is_none() {
            return None;
        }

        // The shared solver owns local realization, but ACE still needs a
        // MoveToState edge so observers receive motion-state broadcasts.
        Some(MotionState {
            gait: intent.gait,
            locomotion,
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
    pub(crate) fn advance_local_pose_for_manual_drive(
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
        let velocity = local_velocity_for_state(heading, state, &capabilities);
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
        let raw_delta = Vector3::new(velocity.x * dt_s, velocity.y * dt_s, velocity.z * dt_s);
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
            if triangles.is_empty() && cell_aabb_opt.is_none() {
                Vector3::zero()
            } else {
                let pre_clamped = if !triangles.is_empty() {
                    holtburger_world::spatial::clamp_delta_against_cell_walls(
                        triangles,
                        &pose,
                        lateral,
                        holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                        holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT,
                    )
                } else {
                    lateral
                };
                // Always also apply the AABB containment clamp as a
                // safety net — even with per-poly walls, an L-shaped
                // cell whose wall triangles are missing on one segment
                // could let the player drift out of the AABB. Cheap
                // and idempotent on top of per-poly.
                match cell_aabb_opt {
                    Some(aabb) => holtburger_world::spatial::clamp_delta_to_cell_interior(
                        &pose,
                        pre_clamped,
                        &aabb,
                        holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                    ),
                    None => pre_clamped,
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
        pose.coords.x += lateral_clamped.x;
        pose.coords.y += lateral_clamped.y;
        // Pre-bake gate: zero Z delta when the indoor cell is
        // unbaked, same rationale as the lateral zero above —
        // sending an uncorrected Z drift would let ACE force-
        // reposition us back to spawn.
        //
        // Airborne integration. When `world.player.is_airborne`,
        // the player is in mid-jump or mid-fall: integrate gravity
        // into the vertical velocity, then add velocity * dt to
        // pose.z. Mirrors ACE's airborne Player_Move handling.
        // While airborne the per-tick floor snap below treats the
        // floor as a *landing trigger* rather than a clamp, so the
        // jump arc plays out cleanly.
        //
        // `9.8 m/s²` matches ACE's `MovementSystem.GetJumpHeight`
        // kinematic (`v = sqrt(h * 19.6)` ⇒ `g = 9.8`). Step is
        // first-order Euler — fine at 60Hz / 16ms ticks, the
        // accumulated error over a typical 1-sec jump is < 1 cm.
        if !indoor_unbaked {
            if world.player.is_airborne {
                let dt_s = dt.as_secs_f32();
                world.player.vertical_velocity -= 9.8 * dt_s;
                pose.coords.z += world.player.vertical_velocity * dt_s;
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
                    pose.coords.z = z;
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

        session
            .send_action(GameAction::AutonomousPosition(Box::new(pulse)))
            .await?;
        self.heartbeats_sent = self.heartbeats_sent.wrapping_add(1);

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

        session
            .send_action(GameAction::AutonomousPosition(Box::new(pulse)))
            .await?;

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
