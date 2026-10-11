//! MoveTo refactor phase B (2026-10-10) — an object's own motion as body
//! motion: the velocity and turn rate its interpreted motion state gives it.
//!
//! Retail moves EVERY object by its animation sequence. The motion table
//! plays the interpreted state's cycle (forward slot) and modifiers
//! (sidestep, turn); `CMotionTable::add_motion` / `combine_motion` set the
//! sequence velocity and omega to `MotionData × speed`
//! (`acclient.c:337431-337474`, `:337477`); `CPartArray::Update` →
//! `CSequence::apply_physics` (`:339860-339890`) turns them into the
//! per-frame offset that `CPhysicsObj::UpdatePositionInternal` composes onto
//! the object (`:319989-320031`, on walkable ground only). A MoveTo has no
//! physics of its own: `MoveToManager::_DoMotion` (`:344753`) only puts
//! RunForward / TurnRight / … on the mover's interp, and the mover then
//! travels at that motion's authored speed.
//!
//! So the speed source is the object's own MotionTable, not the
//! `get_state_velocity` constants (`:343539`, which retail uses for the
//! leave-ground velocity only). Measured on the 2026-08-11 retail oracle
//! capture (`harness/fixtures/oracle/session2/retail-walk-edge-after-
//! manualheld-walk.jsonl`): the retail client walked ~2.55 m/s on flat
//! ground — the player table's 2.6017, not 3.12.
//!
//! What the tables hold (census `holtburger-dat`
//! `motion_table::tests::locomotion_cycle_census`, all 436 retail tables):
//! - WalkForward / RunForward cycles author NO `MotionData.velocity` in any
//!   table (286 tables have them). Their travel is the animation's own
//!   position frames, which the MOTK bake turns into an average speed
//!   (`dat2hba.rs` `derive_animation_forward_speed`; player table: walk
//!   2.6017, run 4.000) stored as the magnitude on x.
//! - SideStepRight carries velocity only on the MODIFIER (player table
//!   `(1.25, 0, 0)`); the MOTK bake keeps cycles only, so sidestep uses the
//!   1.25 `SidestepAnimSpeed` the modifier authors.
//! - TurnRight authors omega on the cycle and the modifier (player table
//!   `(0, 0, −1.5)`).
//!
//! Tables without an authored cycle fall back to the retail constants
//! (`RunAnimSpeed` 4.0, `WalkAnimSpeed` 3.12, `SidestepAnimSpeed` 1.25, the
//! human TurnRight omega −1.5 rad/s), so an object with no resolvable table
//! still moves the way the pre-refactor lanes moved it.

use super::interp_state::{InterpretedForwardCommand, InterpretedState};
use super::motion_interp::{
    MOTION_RUN_FORWARD, MOTION_SIDESTEP_RIGHT, MOTION_TURN_RIGHT, MOTION_WALK_FORWARD,
    RUN_ANIM_SPEED, SIDESTEP_ANIM_SPEED, WALK_ANIM_SPEED,
};
use holtburger_common::Vector3;
use holtburger_dat::file_type::MotionKinematics;

/// The player table's TurnRight `MotionData.omega.z` (rad/s; negative =
/// clockwise from above = heading increasing). Retail tables author
/// −1.0 … −4.5; this is the fallback for an object whose table is unknown.
pub const FALLBACK_TURN_RIGHT_OMEGA_Z: f32 = -1.5;

/// One object's motion for one instant: body-frame velocity (x = right,
/// y = forward, z = up) and the angular velocity about +z.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RootMotion {
    pub velocity: Vector3,
    pub omega_z: f32,
}

impl RootMotion {
    pub fn is_still(&self) -> bool {
        self.velocity.x == 0.0 && self.velocity.y == 0.0 && self.velocity.z == 0.0 && self.omega_z == 0.0
    }
}

/// Where an object's motion table lives: the baked per-table cycle
/// kinematics (`MotionKinematics`, MOTK) and the object's table id.
#[derive(Clone, Copy)]
pub struct MotionTableRef<'a> {
    pub kinematics: &'a MotionKinematics,
    pub motion_table_id: u32,
}

impl MotionTableRef<'_> {
    /// The cycle's `(velocity, omega)` in `style`, falling back to the
    /// table's default style (retail `GetObjectSequence` resolves a style
    /// without the cycle through the default style; holtburger-dat
    /// `cycle_for_*` does the same, cmotiontable-4).
    fn cycle(&self, style: u32, command: u32) -> Option<(Option<Vector3>, Option<Vector3>)> {
        let lookup = |style: u32| {
            self.kinematics
                .cycle_kinematics(self.motion_table_id, style, command)
                .map(|k| (k.velocity, k.omega))
        };
        lookup(style).or_else(|| {
            let default = self
                .kinematics
                .default_style_for_motion_table(self.motion_table_id)?;
            (default != style).then(|| lookup(default)).flatten()
        })
    }

    /// Forward speed (m/s at speed 1) of a forward-slot cycle. An authored
    /// velocity is the body-frame `(0, y, 0)`. The MOTK bake also derives a
    /// speed for WalkForward/RunForward cycles that author none (the
    /// animation's position frames, `dat2hba.rs`
    /// `derive_animation_forward_speed`) and stores that magnitude on x —
    /// read it as forward.
    fn forward_speed(&self, style: u32, command: u32) -> Option<f32> {
        let (velocity, _) = self.cycle(style, command)?;
        let v = velocity?;
        if v.y != 0.0 {
            Some(v.y)
        } else if v.x != 0.0 && v.z == 0.0 {
            Some(v.x.abs())
        } else {
            None
        }
    }

    fn sidestep_speed(&self, style: u32) -> Option<f32> {
        let (velocity, _) = self.cycle(style, MOTION_SIDESTEP_RIGHT)?;
        velocity.map(|v| v.x).filter(|x| *x != 0.0)
    }

    fn turn_omega_z(&self, style: u32) -> Option<f32> {
        let (_, omega) = self.cycle(style, MOTION_TURN_RIGHT)?;
        omega.map(|o| o.z).filter(|z| z.is_finite() && *z != 0.0)
    }
}

/// The body motion an interpreted state produces (see the module doc).
/// `table` = `None` uses the retail constants throughout.
pub fn root_motion(state: &InterpretedState, table: Option<MotionTableRef<'_>>) -> RootMotion {
    let style = state.current_style;
    let mut velocity = Vector3::zero();

    let forward = match state.forward_command {
        Some(InterpretedForwardCommand::WalkForward) => Some((MOTION_WALK_FORWARD, WALK_ANIM_SPEED)),
        Some(InterpretedForwardCommand::RunForward) => Some((MOTION_RUN_FORWARD, RUN_ANIM_SPEED)),
        // A substate in the forward slot (gesture, crouch, …) and Ready carry
        // no locomotion.
        Some(InterpretedForwardCommand::Substate(_)) | None => None,
    };
    if let Some((command, fallback)) = forward {
        let base = table
            .and_then(|t| t.forward_speed(style, command))
            .unwrap_or(fallback);
        velocity.y = base * state.forward_speed;
    }

    if state.sidestep {
        let base = table
            .and_then(|t| t.sidestep_speed(style))
            .unwrap_or(SIDESTEP_ANIM_SPEED);
        velocity.x = base * state.sidestep_speed;
    }

    let omega_z = if state.turn {
        table
            .and_then(|t| t.turn_omega_z(style))
            .unwrap_or(FALLBACK_TURN_RIGHT_OMEGA_Z)
            * state.turn_speed
    } else {
        0.0
    };

    RootMotion { velocity, omega_z }
}

/// Test fixture shared with the scene spine tests: the player table as the
/// MOTK bake stores it — walk/run derived from the animations' position
/// frames (magnitude on x), TurnRight omega authored, no SideStepRight
/// velocity on the cycle.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use holtburger_dat::file_type::{MotionCommandKinematics, MotionKinematicsTable};

    pub(crate) const NONCOMBAT: u32 = 0x8000_003D;
    pub(crate) const PLAYER_TABLE: u32 = 0x0900_0001;

    pub(crate) fn player_kinematics() -> MotionKinematics {
        let mut table = MotionKinematicsTable::new(PLAYER_TABLE, NONCOMBAT);
        let cycle = |velocity: Option<Vector3>, omega: Option<Vector3>| MotionCommandKinematics {
            velocity,
            omega,
        };
        table.insert_cycle_kinematics(
            NONCOMBAT,
            MOTION_WALK_FORWARD,
            cycle(Some(Vector3::new(2.6017, 0.0, 0.0)), None),
        );
        table.insert_cycle_kinematics(
            NONCOMBAT,
            MOTION_RUN_FORWARD,
            cycle(Some(Vector3::new(4.0, 0.0, 0.0)), None),
        );
        table.insert_cycle_kinematics(
            NONCOMBAT,
            MOTION_TURN_RIGHT,
            cycle(None, Some(Vector3::new(0.0, 0.0, -1.5))),
        );
        table.insert_cycle_kinematics(NONCOMBAT, MOTION_SIDESTEP_RIGHT, cycle(None, None));
        let mut kinematics = MotionKinematics::new();
        kinematics.motion_tables.insert(PLAYER_TABLE, table);
        kinematics
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{PLAYER_TABLE as TABLE, player_kinematics};
    use super::*;

    const SWORD: u32 = 0x8000_003E;

    fn state(
        forward: Option<InterpretedForwardCommand>,
        forward_speed: f32,
        sidestep_speed: Option<f32>,
        turn_speed: Option<f32>,
    ) -> InterpretedState {
        InterpretedState {
            forward_command: forward,
            forward_speed,
            sidestep: sidestep_speed.is_some(),
            sidestep_speed: sidestep_speed.unwrap_or(1.0),
            turn: turn_speed.is_some(),
            turn_speed: turn_speed.unwrap_or(1.0),
            ..InterpretedState::default()
        }
    }

    #[test]
    fn forward_speed_comes_from_the_table_animation_speed() {
        let kinematics = player_kinematics();
        let table = Some(MotionTableRef { kinematics: &kinematics, motion_table_id: TABLE });

        // Walk: the table's 2.6017, not the 3.12 WalkAnimSpeed constant.
        let walk = root_motion(&state(Some(InterpretedForwardCommand::WalkForward), 1.0, None, None), table);
        assert!((walk.velocity.y - 2.6017).abs() < 1e-4, "{walk:?}");
        assert_eq!(walk.velocity.x, 0.0);

        // Run at run rate 1.97 (the interpreted speed already carries it).
        let run = root_motion(&state(Some(InterpretedForwardCommand::RunForward), 1.97, None, None), table);
        assert!((run.velocity.y - 4.0 * 1.97).abs() < 1e-4, "{run:?}");

        // Backstep: WalkForward × −0.65 travels backwards at the table speed.
        let back = root_motion(&state(Some(InterpretedForwardCommand::WalkForward), -0.65, None, None), table);
        assert!((back.velocity.y + 2.6017 * 0.65).abs() < 1e-4, "{back:?}");

        // A substate in the forward slot and Ready do not travel.
        let gesture = root_motion(&state(Some(InterpretedForwardCommand::Substate(0x4000_002B)), 1.0, None, None), table);
        assert!(gesture.is_still());
        assert!(root_motion(&state(None, 1.0, None, None), table).is_still());
    }

    #[test]
    fn style_without_the_cycle_uses_the_default_style() {
        let kinematics = player_kinematics();
        let table = Some(MotionTableRef { kinematics: &kinematics, motion_table_id: TABLE });
        let mut s = state(Some(InterpretedForwardCommand::RunForward), 1.0, None, Some(1.0));
        s.current_style = SWORD;
        let m = root_motion(&s, table);
        assert!((m.velocity.y - 4.0).abs() < 1e-4);
        assert!((m.omega_z + 1.5).abs() < 1e-6);
    }

    #[test]
    fn turn_and_sidestep_axes() {
        let kinematics = player_kinematics();
        let table = Some(MotionTableRef { kinematics: &kinematics, motion_table_id: TABLE });
        // TurnLeft is TurnRight with a negative speed; the run hold key's 1.5
        // is already in the interpreted speed.
        let left = root_motion(&state(None, 1.0, None, Some(-1.5)), table);
        assert!((left.omega_z - 2.25).abs() < 1e-5, "{left:?}");
        // Sidestep: the cycle authors no velocity → the modifier's 1.25.
        let side = root_motion(&state(None, 1.0, Some(-1.248), None), table);
        assert!((side.velocity.x + 1.25 * 1.248).abs() < 1e-4, "{side:?}");
        assert_eq!(side.velocity.y, 0.0);
    }

    #[test]
    fn unknown_table_falls_back_to_the_retail_constants() {
        let walk = root_motion(&state(Some(InterpretedForwardCommand::WalkForward), 1.0, None, Some(1.0)), None);
        assert!((walk.velocity.y - WALK_ANIM_SPEED).abs() < 1e-5);
        assert!((walk.omega_z - FALLBACK_TURN_RIGHT_OMEGA_Z).abs() < 1e-6);
        let run = root_motion(&state(Some(InterpretedForwardCommand::RunForward), 2.0, None, None), None);
        assert!((run.velocity.y - RUN_ANIM_SPEED * 2.0).abs() < 1e-5);
    }
}
