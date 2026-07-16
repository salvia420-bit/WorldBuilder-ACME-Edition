use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Vector3};
use holtburger_protocol::messages::movement::MotionStance;
use std::time::Duration;

pub(crate) fn planar_velocity_for_heading(heading: f32, speed: f32) -> Vector3 {
    Vector3::new(-heading.cos() * speed, heading.sin() * speed, 0.0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MotionStyle {
    #[default]
    PreserveServer,
    Explicit(MotionStance),
    Omit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MovementPacketMetadata {
    pub contact: Option<bool>,
    pub motion_style: MotionStyle,
}

impl MovementPacketMetadata {
    pub const fn with_contact(contact: bool) -> Self {
        Self {
            contact: Some(contact),
            motion_style: MotionStyle::PreserveServer,
        }
    }

    pub const fn with_motion_style(motion_style: MotionStyle) -> Self {
        Self {
            contact: None,
            motion_style,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Gait {
    #[default]
    Walk,
    Run,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AutonomousDriveIntent {
    pub desired_world_delta: Vector3,
    pub desired_heading: Option<f32>,
    pub target_hint: Option<WorldPosition>,
    pub gait: Gait,
    pub force_grounded: bool,
}

/// Forward-axis locomotion slot — `RawMotionState::ForwardCommand`.
///
/// Wave 2 Phase 2.2 (2026-05-26): split out of the original single-valued
/// `Locomotion` so the forward axis (W/S) can coexist on the wire with an
/// independent sidestep axis (A/D). Retail's `InterpretedMotionState`
/// (`~/ac-headers/acclient.c:332759-332786`) and ACE's `RawMotionState`
/// (`external/ACE/Source/ACE.Server/Physics/Animation/RawMotionState.cs:32-98`)
/// both treat forward / sidestep / turn as three independent fields; pre-2.2
/// we silently dropped sidestep when forward was non-zero. See
/// `docs/wave-2-diagonal-composition-2026-05-26.md` for the analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForwardLocomotion {
    Forward,
    Backstep,
}

/// Sidestep-axis locomotion slot — `RawMotionState::SidestepCommand`.
///
/// Independent of `ForwardLocomotion`; both can be populated simultaneously
/// to describe a diagonal walk (W+D = forward + StrafeRight). See
/// `ForwardLocomotion` for context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidestepLocomotion {
    StrafeLeft,
    StrafeRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Turn {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MotionState {
    pub gait: Gait,
    /// Wave 2 Phase 2.2 — forward axis (W/S). Independent of `sidestep`;
    /// both can be `Some(_)` simultaneously per retail / ACE wire shape.
    pub forward: Option<ForwardLocomotion>,
    /// Wave 2 Phase 2.2 — sidestep axis (A/D). Independent of `forward`.
    pub sidestep: Option<SidestepLocomotion>,
    pub turning: Option<Turn>,
    pub turn_speed: Option<f32>,
}

impl MotionState {
    /// True when neither forward nor sidestep is populated. Convenience for
    /// callers that previously checked `state.locomotion.is_some()`.
    pub fn is_locomotion_idle(&self) -> bool {
        self.forward.is_none() && self.sidestep.is_none()
    }
}

impl Default for MotionState {
    fn default() -> Self {
        Self {
            gait: Gait::Walk,
            forward: None,
            sidestep: None,
            turning: None,
            turn_speed: None,
        }
    }
}

impl MotionState {
    pub fn builder() -> MotionStateBuilder {
        MotionStateBuilder::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MotionStateBuilder {
    state: MotionState,
}

impl MotionStateBuilder {
    pub fn walk(mut self) -> Self {
        self.state.gait = Gait::Walk;
        self
    }

    pub fn run(mut self) -> Self {
        self.state.gait = Gait::Run;
        self
    }

    pub fn forward(mut self) -> Self {
        self.state.forward = Some(ForwardLocomotion::Forward);
        self
    }

    pub fn backstep(mut self) -> Self {
        self.state.forward = Some(ForwardLocomotion::Backstep);
        self
    }

    pub fn strafe_left(mut self) -> Self {
        self.state.sidestep = Some(SidestepLocomotion::StrafeLeft);
        self
    }

    pub fn strafe_right(mut self) -> Self {
        self.state.sidestep = Some(SidestepLocomotion::StrafeRight);
        self
    }

    pub fn turn_left(mut self) -> Self {
        self.state.turning = Some(Turn::Left);
        self
    }

    pub fn turn_right(mut self) -> Self {
        self.state.turning = Some(Turn::Right);
        self
    }

    pub fn with_turn_speed(mut self, turn_speed: f32) -> Self {
        self.state.turn_speed = Some(turn_speed);
        self
    }

    pub fn build(self) -> MotionState {
        self.state
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PlayerDriveIntent {
    ManualHeld(MotionState),
    ManualPulse {
        state: MotionState,
        duration: Duration,
    },
    Autonomous(AutonomousDriveIntent),
    ArriveAtPose {
        pose: WorldPosition,
    },
    SnapFacing {
        heading: f32,
    },
    Stop,
    /// A14-I2 (W3+ S10, `?wasmPursuit=on`) — retail
    /// `MovementTypes::MoveToObject = 0x6` (acclient.h:2856-2866) via
    /// the `MoveToManager::PerformMovement` entry
    /// (acclient.c:346123-346145). ENTRY-POINT ONLY — steering/arrival
    /// math lives in `movement/move_to.rs` (A3-D3 driver).
    /// `object_radius`/`object_height` carry the F6-5 cylinder stop
    /// semantics into retail's native dims args (acclient.c:7145; the
    /// SD3D §3 contract resolution — `MovementParameters` untouched).
    /// `run` forces the Run hold key (`bitfield |= 0x10`, ForceRun in
    /// `get_command`, acclient.c:346213-346215) — today's charge
    /// behavior exactly.
    PursueObject {
        target: Guid,
        object_radius: f32,
        object_height: f32,
        run: bool,
    },
    /// A14-I2 — retail `MovementTypes::TurnToObject = 0x8`
    /// (acclient.c:346137-346139). NOT `SnapFacing` — this is the
    /// rate-limited MoveToManager turn, not an instantaneous heading
    /// set.
    TurnToObject { target: Guid },
    /// A14-I2 — retail `TurnToHeading = 0x9` (acclient.c:346141-346143).
    /// `heading` is RADIANS (pose domain); converted to the retail
    /// degrees domain at the `MovementSystem` ingest boundary.
    TurnToHeading { heading: f32 },
    /// A14-I2 — retail `MovementManager::CancelMoveTo(0x36)`
    /// (acclient.c:339240-339246), the JS charge-abort entry.
    CancelPursuit,
    /// rynth-integration Phase 1 (2026-07-16) — retail
    /// `MovementTypes::MoveToPosition = 0x7` (acclient.c:345790-345857)
    /// through the same MoveToManager driver as `PursueObject`. The nav
    /// keystone (docs/rynth-integration README §Phase 1): a router leg
    /// is "walk to this pose", no target object. `cell_id`/`position`
    /// are AC-native landblock + local coords (Z-up); `run` forces the
    /// Run hold key exactly like `PursueObject`.
    MoveToPosition {
        cell_id: Guid,
        position: Vector3,
        run: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Guid, Quaternion};

    #[test]
    fn planar_velocity_matches_ac_heading_convention() {
        let west_velocity = planar_velocity_for_heading(0.0, 2.0);
        let north_velocity = planar_velocity_for_heading(90.0f32.to_radians(), 2.0);

        assert_eq!(west_velocity, Vector3::new(-2.0, 0.0, 0.0));
        assert!(north_velocity.x.abs() < 1e-5);
        assert!((north_velocity.y - 2.0).abs() < 1e-5);
    }

    #[test]
    fn metadata_can_override_motion_style_without_contact() {
        let metadata =
            MovementPacketMetadata::with_motion_style(MotionStyle::Explicit(MotionStance::Magic));

        assert_eq!(metadata.contact, None);
        assert_eq!(
            metadata.motion_style,
            MotionStyle::Explicit(MotionStance::Magic)
        );
    }

    #[test]
    fn movement_packet_metadata_defaults_to_preserve_server_style() {
        let metadata = MovementPacketMetadata::default();

        assert_eq!(metadata.contact, None);
        assert_eq!(metadata.motion_style, MotionStyle::PreserveServer);
    }

    #[test]
    fn motion_state_builder_builds_resolved_motion_state() {
        let state = MotionState::builder()
            .run()
            .forward()
            .turn_left()
            .with_turn_speed(1.25)
            .build();

        assert_eq!(state.gait, Gait::Run);
        assert_eq!(state.forward, Some(ForwardLocomotion::Forward));
        assert_eq!(state.sidestep, None);
        assert_eq!(state.turning, Some(Turn::Left));
        assert_eq!(state.turn_speed, Some(1.25));
    }

    #[test]
    fn motion_state_defaults_to_walk_with_no_axes() {
        let state = MotionState::default();

        assert_eq!(state.gait, Gait::Walk);
        assert_eq!(state.forward, None);
        assert_eq!(state.sidestep, None);
        assert_eq!(state.turning, None);
        assert_eq!(state.turn_speed, None);
        assert!(state.is_locomotion_idle());
    }

    /// Wave 2 Phase 2.2 (2026-05-26) — W+D / W+A populates BOTH the forward
    /// and sidestep slots on a single `MotionState`. Pre-2.2 the builder
    /// silently overwrote one with the other; this guards that the new
    /// independent slots coexist.
    #[test]
    fn motion_state_builder_can_combine_forward_and_sidestep() {
        let state = MotionState::builder()
            .run()
            .forward()
            .strafe_right()
            .build();

        assert_eq!(state.gait, Gait::Run);
        assert_eq!(state.forward, Some(ForwardLocomotion::Forward));
        assert_eq!(state.sidestep, Some(SidestepLocomotion::StrafeRight));
        assert!(!state.is_locomotion_idle());
    }

    /// Wave 2 Phase 2.2 (2026-05-26) — S+A composes backstep + strafe-left.
    #[test]
    fn motion_state_builder_can_combine_backstep_and_strafe_left() {
        let state = MotionState::builder()
            .walk()
            .backstep()
            .strafe_left()
            .build();

        assert_eq!(state.gait, Gait::Walk);
        assert_eq!(state.forward, Some(ForwardLocomotion::Backstep));
        assert_eq!(state.sidestep, Some(SidestepLocomotion::StrafeLeft));
    }

    #[test]
    fn manual_held_intent_preserves_resolved_state() {
        let intent = PlayerDriveIntent::ManualHeld(
            MotionState::builder().run().forward().turn_right().build(),
        );

        assert_eq!(
            intent,
            PlayerDriveIntent::ManualHeld(MotionState {
                gait: Gait::Run,
                forward: Some(ForwardLocomotion::Forward),
                sidestep: None,
                turning: Some(Turn::Right),
                turn_speed: None,
            })
        );
    }

    #[test]
    fn manual_pulse_intent_preserves_duration_and_state() {
        let intent = PlayerDriveIntent::ManualPulse {
            state: MotionState::builder().walk().forward().build(),
            duration: Duration::from_millis(120),
        };

        assert_eq!(
            intent,
            PlayerDriveIntent::ManualPulse {
                state: MotionState {
                    gait: Gait::Walk,
                    forward: Some(ForwardLocomotion::Forward),
                    sidestep: None,
                    turning: None,
                    turn_speed: None,
                },
                duration: Duration::from_millis(120),
            }
        );
    }

    #[test]
    fn snap_facing_intent_is_one_shot() {
        let command = PlayerDriveIntent::SnapFacing { heading: 1.0 };

        assert_eq!(command, PlayerDriveIntent::SnapFacing { heading: 1.0 });
    }

    #[test]
    fn stop_intent_is_distinct_from_manual_motion_intents() {
        assert_ne!(
            PlayerDriveIntent::Stop,
            PlayerDriveIntent::ManualPulse {
                state: MotionState::builder().walk().forward().build(),
                duration: Duration::from_millis(120),
            }
        );
        assert_ne!(
            PlayerDriveIntent::Stop,
            PlayerDriveIntent::ManualHeld(MotionState::builder().walk().forward().build())
        );
    }

    #[test]
    fn autonomous_drive_intent_preserves_requested_fields() {
        let intent = AutonomousDriveIntent {
            desired_world_delta: Vector3::new(1.0, 2.0, 3.0),
            desired_heading: Some(1.25),
            target_hint: Some(WorldPosition {
                landblock_id: Guid(0x1234_0100),
                coords: Vector3::new(4.0, 5.0, 6.0),
                rotation: Quaternion::identity(),
            }),
            gait: Gait::Run,
            force_grounded: true,
        };

        assert_eq!(intent.desired_world_delta, Vector3::new(1.0, 2.0, 3.0));
        assert_eq!(intent.desired_heading, Some(1.25));
        assert_eq!(
            intent.target_hint,
            Some(WorldPosition {
                landblock_id: Guid(0x1234_0100),
                coords: Vector3::new(4.0, 5.0, 6.0),
                rotation: Quaternion::identity(),
            })
        );
        assert_eq!(intent.gait, Gait::Run);
        assert!(intent.force_grounded);
    }

    #[test]
    fn player_drive_intent_can_wrap_autonomous_drive() {
        let intent = PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
            desired_world_delta: Vector3::new(0.0, 1.0, 0.0),
            desired_heading: None,
            target_hint: None,
            gait: Gait::Walk,
            force_grounded: false,
        });

        assert!(matches!(
            intent,
            PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
                desired_world_delta,
                desired_heading: None,
                target_hint: None,
                gait: Gait::Walk,
                force_grounded: false,
            }) if desired_world_delta == Vector3::new(0.0, 1.0, 0.0)
        ));
    }
}
