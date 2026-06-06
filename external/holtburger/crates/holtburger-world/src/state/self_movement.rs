use crate::context::WorldContextExt as _;
use crate::state::WorldState;
use crate::state::motion_resolution::{
    PlayerMotionTableLookupError, PlayerMotionTableResolution, PlayerMotionTableSource,
};
use holtburger_common::Vector3;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredSelfMovementKinematics {
    RunForwardVelocity,
    TurnOmega,
}

impl RequiredSelfMovementKinematics {
    const fn label(self) -> &'static str {
        match self {
            Self::RunForwardVelocity => "run-forward velocity",
            Self::TurnOmega => "turn omega",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SelfMovementKinematics {
    pub source: PlayerMotionTableSource,
    pub motion_table_id: u32,
    pub stance: u32,
    pub base_walk_forward_velocity: Vector3,
    pub base_run_forward_velocity: Vector3,
    pub base_turn_left_omega: Vector3,
    pub base_turn_right_omega: Vector3,
}

impl SelfMovementKinematics {
    pub fn base_walk_forward_speed(&self) -> f32 {
        self.base_walk_forward_velocity.length()
    }

    pub fn base_run_forward_speed(&self) -> f32 {
        self.base_run_forward_velocity.length()
    }

    pub fn resolved_manual_run_speed(&self, run_rate_scalar: f32) -> f32 {
        self.base_run_forward_speed() * run_rate_scalar
    }

    pub fn resolved_autonomous_run_speed(
        &self,
        run_rate_scalar: f32,
        speed_multiplier: f32,
    ) -> f32 {
        self.resolved_manual_run_speed(run_rate_scalar) * speed_multiplier
    }

    pub fn resolved_manual_run_velocity(&self, run_rate_scalar: f32) -> Vector3 {
        self.base_run_forward_velocity * run_rate_scalar
    }

    pub fn resolved_autonomous_run_velocity(
        &self,
        run_rate_scalar: f32,
        speed_multiplier: f32,
    ) -> Vector3 {
        self.resolved_manual_run_velocity(run_rate_scalar) * speed_multiplier
    }

    pub fn base_turn_left_speed_rad_per_sec(&self) -> f32 {
        self.base_turn_left_omega.length()
    }

    pub fn base_turn_right_speed_rad_per_sec(&self) -> f32 {
        self.base_turn_right_omega.length()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SelfMovementCapabilities {
    pub kinematics: SelfMovementKinematics,
    pub run_rate_scalar: f32,
}

impl SelfMovementCapabilities {
    pub fn source(&self) -> PlayerMotionTableSource {
        self.kinematics.source
    }

    pub fn motion_table_id(&self) -> u32 {
        self.kinematics.motion_table_id
    }

    pub fn stance(&self) -> u32 {
        self.kinematics.stance
    }

    pub fn base_walk_forward_speed(&self) -> f32 {
        self.kinematics.base_walk_forward_speed()
    }

    pub fn base_run_forward_speed(&self) -> f32 {
        self.kinematics.base_run_forward_speed()
    }

    pub fn resolved_manual_run_speed(&self) -> f32 {
        self.kinematics
            .resolved_manual_run_speed(self.run_rate_scalar)
    }

    pub fn resolved_autonomous_run_speed(&self, speed_multiplier: f32) -> f32 {
        self.kinematics
            .resolved_autonomous_run_speed(self.run_rate_scalar, speed_multiplier)
    }

    pub fn resolved_manual_run_velocity(&self) -> Vector3 {
        self.kinematics
            .resolved_manual_run_velocity(self.run_rate_scalar)
    }

    pub fn resolved_autonomous_run_velocity(&self, speed_multiplier: f32) -> Vector3 {
        self.kinematics
            .resolved_autonomous_run_velocity(self.run_rate_scalar, speed_multiplier)
    }

    pub fn base_turn_left_speed_rad_per_sec(&self) -> f32 {
        self.kinematics.base_turn_left_speed_rad_per_sec()
    }

    pub fn base_turn_right_speed_rad_per_sec(&self) -> f32 {
        self.kinematics.base_turn_right_speed_rad_per_sec()
    }

    pub fn kinematics(&self) -> &SelfMovementKinematics {
        &self.kinematics
    }
}

/// Retail motion-modifier physics — `combine_motion`/`subtract_motion`
/// (`acclient.c:337477`/`:337505`), `combine_physics` (`:339714`), and
/// `re_modify` (`:337286`). A modifier is **visually inert** — verified:
/// `combine_motion` appends NO animation frames, it only calls `combine_physics`
/// — yet **behaviorally real**: each held modifier adds its `(velocity, omega) *
/// speed_mod` to the running motion, and `re_modify` re-applies the whole held
/// set across a base-cycle swap so the physics PERSISTS through it (e.g. movement
/// physics held through a cast-gesture cycle swap — the fastcast case). Built for
/// behavioral (not visual) retail parity; gated where wired.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MotionPhysics {
    pub velocity: Vector3,
    pub omega: Vector3,
}

impl MotionPhysics {
    /// `CSequence::combine_physics` (`acclient.c:339714`) — component-wise add.
    pub fn combine_physics(&mut self, velocity: Vector3, omega: Vector3) {
        self.velocity = self.velocity + velocity;
        self.omega = self.omega + omega;
    }

    /// Inverse of `combine_physics` (`acclient.c:339730`) — component-wise sub.
    pub fn subtract_physics(&mut self, velocity: Vector3, omega: Vector3) {
        self.velocity = self.velocity - velocity;
        self.omega = self.omega - omega;
    }

    /// `combine_motion` (`acclient.c:337477`) — add a modifier's `(velocity,
    /// omega)` scaled by `speed_mod`.
    pub fn combine_motion(&mut self, velocity: Vector3, omega: Vector3, speed_mod: f32) {
        self.combine_physics(velocity * speed_mod, omega * speed_mod);
    }

    /// `subtract_motion` (`acclient.c:337505`).
    pub fn subtract_motion(&mut self, velocity: Vector3, omega: Vector3, speed_mod: f32) {
        self.subtract_physics(velocity * speed_mod, omega * speed_mod);
    }
}

/// The held modifier set — the `MotionState` modifier list
/// (`add_modifier`/`remove_modifier`/`clear_modifiers`, `acclient.c:6979-6991`).
/// `combined_onto` mirrors `re_modify` (`:337286`): re-apply every held modifier
/// onto a fresh base, so the held physics survives a base-cycle swap. Each entry
/// is a `(velocity, omega, speed_mod)` modifier.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MotionModifierStack {
    modifiers: Vec<(Vector3, Vector3, f32)>,
}

impl MotionModifierStack {
    /// `MotionState::add_modifier` (`acclient.c:6991`).
    pub fn add_modifier(&mut self, velocity: Vector3, omega: Vector3, speed_mod: f32) {
        self.modifiers.push((velocity, omega, speed_mod));
    }

    /// `MotionState::clear_modifiers` (`acclient.c:6981`).
    pub fn clear(&mut self) {
        self.modifiers.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.modifiers.is_empty()
    }

    pub fn len(&self) -> usize {
        self.modifiers.len()
    }

    /// `CMotionTable::re_modify` (`acclient.c:337286`): re-apply every held
    /// modifier's physics onto `base` (e.g. after a base-cycle swap) and return
    /// the combined physics — the held modifiers persist across the swap.
    pub fn combined_onto(&self, base: MotionPhysics) -> MotionPhysics {
        let mut out = base;
        for &(velocity, omega, speed_mod) in &self.modifiers {
            out.combine_motion(velocity, omega, speed_mod);
        }
        out
    }
}

#[derive(Debug, Error)]
pub enum SelfMovementKinematicsError {
    #[error(transparent)]
    MotionTableLookup(#[from] PlayerMotionTableLookupError),
    #[error(
        "motion table 0x{motion_table_id:08X} stance 0x{stance:08X} is missing required {kind_label}"
    )]
    MissingRequiredKinematics {
        motion_table_id: u32,
        stance: u32,
        kind: RequiredSelfMovementKinematics,
        kind_label: &'static str,
    },
}

#[derive(Debug, Error)]
pub enum SelfMovementCapabilitiesError {
    #[error("player run-rate scalar is unavailable")]
    RunRateUnavailable,
    #[error(transparent)]
    Kinematics(#[from] SelfMovementKinematicsError),
}

impl WorldState {
    pub fn resolve_self_movement_kinematics(
        &self,
    ) -> Result<SelfMovementKinematics, SelfMovementKinematicsError> {
        if let Some(override_capabilities) = &self.self_movement_capabilities_override {
            return Ok(override_capabilities.kinematics().clone());
        }

        let resolution = self.resolve_player_motion_table_profile()?;
        let base_run_forward_velocity = required_velocity(
            &resolution,
            RequiredSelfMovementKinematics::RunForwardVelocity,
        )?;
        let (base_turn_left_omega, base_turn_right_omega) = resolved_turn_omegas(&resolution)?;
        let movement_profile = &resolution.movement_profile;

        Ok(SelfMovementKinematics {
            source: resolution.source,
            motion_table_id: movement_profile.motion_table_id,
            stance: movement_profile.stance,
            base_walk_forward_velocity: optional_forward_velocity(&resolution)
                .unwrap_or(base_run_forward_velocity),
            base_run_forward_velocity,
            base_turn_left_omega,
            base_turn_right_omega,
        })
    }

    pub fn resolve_self_movement_capabilities(
        &self,
    ) -> Result<SelfMovementCapabilities, SelfMovementCapabilitiesError> {
        if let Some(override_capabilities) = &self.self_movement_capabilities_override {
            return Ok(override_capabilities.clone());
        }

        let run_rate_scalar = self
            .player_run_rate()
            .ok_or(SelfMovementCapabilitiesError::RunRateUnavailable)?;
        let kinematics = self.resolve_self_movement_kinematics()?;

        Ok(SelfMovementCapabilities {
            kinematics,
            run_rate_scalar,
        })
    }

    /// Install a fallback `SelfMovementCapabilities` override. Used by
    /// the wasm bundle (Phase 4 step 3.6) when the player's biota
    /// isn't loaded — without an override, `resolve_self_movement_capabilities`
    /// errors with `RunRateUnavailable` and the local-pose integrator
    /// in `MovementSystemHandle::tick` no-ops, leaving server-side
    /// position frozen at spawn. (Originally `#[cfg(test, feature =
    /// "test-support")]` for unit-test fixtures; the setter itself is
    /// just a field write, no test-only logic, so unblocking the
    /// production wasm path is fine.)
    pub fn set_self_movement_capabilities_override(
        &mut self,
        capabilities: SelfMovementCapabilities,
    ) {
        self.self_movement_capabilities_override = Some(capabilities);
    }

    pub fn clear_self_movement_capabilities_override(&mut self) {
        self.self_movement_capabilities_override = None;
    }
}

fn optional_forward_velocity(resolution: &PlayerMotionTableResolution) -> Option<Vector3> {
    resolution
        .movement_profile
        .walk_forward
        .and_then(|entry| entry.velocity)
}

fn required_velocity(
    resolution: &PlayerMotionTableResolution,
    kind: RequiredSelfMovementKinematics,
) -> Result<Vector3, SelfMovementKinematicsError> {
    let velocity = match kind {
        RequiredSelfMovementKinematics::RunForwardVelocity => resolution
            .movement_profile
            .run_forward
            .and_then(|entry| entry.velocity),
        RequiredSelfMovementKinematics::TurnOmega => None,
    };

    velocity.ok_or_else(|| missing_required_kinematics_error(resolution, kind))
}

fn optional_turn_left_omega(resolution: &PlayerMotionTableResolution) -> Option<Vector3> {
    resolution
        .movement_profile
        .turn_left
        .and_then(|entry| entry.omega)
}

fn optional_turn_right_omega(resolution: &PlayerMotionTableResolution) -> Option<Vector3> {
    resolution
        .movement_profile
        .turn_right
        .and_then(|entry| entry.omega)
}

fn resolved_turn_omegas(
    resolution: &PlayerMotionTableResolution,
) -> Result<(Vector3, Vector3), SelfMovementKinematicsError> {
    match (
        optional_turn_left_omega(resolution),
        optional_turn_right_omega(resolution),
    ) {
        (Some(left), Some(right)) => Ok((left, right)),
        (Some(left), None) => Ok((left, left * -1.0)),
        (None, Some(right)) => Ok((right * -1.0, right)),
        (None, None) => Err(missing_required_kinematics_error(
            resolution,
            RequiredSelfMovementKinematics::TurnOmega,
        )),
    }
}

fn missing_required_kinematics_error(
    resolution: &PlayerMotionTableResolution,
    kind: RequiredSelfMovementKinematics,
) -> SelfMovementKinematicsError {
    SelfMovementKinematicsError::MissingRequiredKinematics {
        motion_table_id: resolution.movement_profile.motion_table_id,
        stance: resolution.movement_profile.stance,
        kind,
        kind_label: kind.label(),
    }
}

#[cfg(test)]
mod modifier_tests {
    use super::{MotionModifierStack, MotionPhysics};
    use holtburger_common::Vector3;

    /// `combine_motion` (acclient.c:337489-337501): `v += speed_mod*data.velocity`,
    /// `o += speed_mod*data.omega`.
    #[test]
    fn combine_motion_adds_scaled_physics_per_acclient() {
        let mut p = MotionPhysics::default();
        p.combine_motion(Vector3::new(2.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.5), 1.0);
        assert_eq!(p.velocity, Vector3::new(2.0, 0.0, 0.0));
        assert_eq!(p.omega, Vector3::new(0.0, 0.0, 1.5));
        p.combine_motion(Vector3::new(1.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0), 0.5);
        assert_eq!(p.velocity, Vector3::new(2.5, 0.0, 0.0));
        assert_eq!(p.omega, Vector3::new(0.0, 0.0, 2.0));
    }

    /// `subtract_motion` (acclient.c:337505) is the exact inverse.
    #[test]
    fn subtract_motion_is_the_inverse() {
        let mut p = MotionPhysics::default();
        let v = Vector3::new(3.0, -1.0, 0.0);
        let o = Vector3::new(0.0, 0.0, 1.5);
        p.combine_motion(v, o, 1.0);
        p.subtract_motion(v, o, 1.0);
        assert_eq!(p.velocity, Vector3::new(0.0, 0.0, 0.0));
        assert_eq!(p.omega, Vector3::new(0.0, 0.0, 0.0));
    }

    /// `re_modify` (acclient.c:337286): a held sidestep + turn modifier set
    /// PERSISTS across a base-cycle swap — the fastcast case (strafe/turn physics
    /// held through a cast-gesture swap, visually inert but behaviorally real).
    #[test]
    fn re_modify_reapplies_held_set_across_a_base_swap() {
        let mut stack = MotionModifierStack::default();
        stack.add_modifier(Vector3::new(0.0, 1.0, 0.0), Vector3::new(0.0, 0.0, 0.0), 1.0); // sidestep
        stack.add_modifier(Vector3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, -1.5), 1.0); // turn
        assert_eq!(stack.len(), 2);

        // base = run-forward (4 m/s +X). Held modifiers add strafe + turn.
        let run_base = MotionPhysics {
            velocity: Vector3::new(4.0, 0.0, 0.0),
            omega: Vector3::new(0.0, 0.0, 0.0),
        };
        let on_run = stack.combined_onto(run_base);
        assert_eq!(on_run.velocity, Vector3::new(4.0, 1.0, 0.0));
        assert_eq!(on_run.omega, Vector3::new(0.0, 0.0, -1.5));

        // Base swaps to a cast gesture (~0 base physics). re_modify re-applies the
        // held set → the strafe + turn PERSIST through the swap.
        let on_cast = stack.combined_onto(MotionPhysics::default());
        assert_eq!(on_cast.velocity, Vector3::new(0.0, 1.0, 0.0));
        assert_eq!(on_cast.omega, Vector3::new(0.0, 0.0, -1.5));

        stack.clear();
        assert!(stack.is_empty());
        assert_eq!(stack.combined_onto(run_base).velocity, run_base.velocity);
    }
}
