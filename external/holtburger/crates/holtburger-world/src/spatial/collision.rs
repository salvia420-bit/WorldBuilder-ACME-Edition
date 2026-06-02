//! Physics deep-dive 2026-06-01: BSP milestone M0 (inert foundation, ZERO behavior change).
//! TransitionState enum and PhysicsGlobals constants aligned with ACE Common/Enum/Transition.cs
//! and verified against acclient.c decompiled headers. Defines the collision state types and
//! constants the future BSP resolver (M2-M6) will consume; nothing uses them yet.

/// Result state of a position transition attempt in the collision resolver.
/// Maps 1:1 to ACE `ACE.Server.Physics.Animation.TransitionState`.
///
/// The resolver processes movement through the landblock/cell graph by testing positions
/// incrementally; each test returns one of these states to drive the next iteration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum TransitionState {
    /// Invalid transition attempt; resolver should restart or fail the move. ACE value: 0x0
    Invalid = 0x0,
    /// Position is valid and collision-free; move can advance. ACE value: 0x1
    OK = 0x1,
    /// Movement collided with an obstacle; stop at the pre-collision position. ACE value: 0x2
    Collided = 0x2,
    /// Movement collided but was adjusted sideways; retry from adjusted position. ACE value: 0x3
    Adjusted = 0x3,
    /// Movement slid along a surface (wall/edge); continue from slid position. ACE value: 0x4
    Slid = 0x4,
}

impl TransitionState {
    /// Check if this state represents a successful (non-blocking) transition.
    pub const fn is_ok(self) -> bool {
        matches!(self, Self::OK)
    }

    /// Check if this state represents a blocking collision.
    pub const fn is_collided(self) -> bool {
        matches!(self, Self::Collided)
    }

    /// Check if this state requests position adjustment and retry.
    pub const fn is_adjusted(self) -> bool {
        matches!(self, Self::Adjusted)
    }

    /// Check if this state indicates motion along a surface.
    pub const fn is_slid(self) -> bool {
        matches!(self, Self::Slid)
    }
}

/// Physics resolver constants derived from ACE `PhysicsGlobals`. These mirror the values
/// already used piecemeal across `physics.rs` / `common.rs`; the future BSP resolver consumes
/// them through this single namespace. (Not yet wired in — M0 is inert scaffolding.)
pub mod physics_globals {
    /// Minimum distance threshold for collision detection and surface classification. ACE: 0.0002
    pub const EPSILON: f32 = 0.0002;
    /// Squared epsilon for distance-squared comparisons.
    pub const EPSILON_SQ: f32 = EPSILON * EPSILON;
    /// Gravity acceleration (downward). ACE: -9.8 m/s²
    pub const GRAVITY: f32 = -9.8;
    /// Default friction coefficient (95% momentum retention per frame). ACE: 0.95
    pub const DEFAULT_FRICTION: f32 = 0.95;
    /// Default elasticity (bounciness). ACE: 0.05
    pub const DEFAULT_ELASTICITY: f32 = 0.05;
    /// Maximum allowed elasticity in a collision response. ACE: 0.1
    pub const MAX_ELASTICITY: f32 = 0.1;
    /// Default mass for objects without an explicit mass. ACE: 1.0 kg
    pub const DEFAULT_MASS: f32 = 1.0;
    /// Default scale factor (100%). ACE: 1.0
    pub const DEFAULT_SCALE: f32 = 1.0;
    /// Terminal velocity magnitude. ACE: 50.0 m/s
    pub const MAX_VELOCITY: f32 = 50.0;
    /// Squared terminal velocity.
    pub const MAX_VELOCITY_SQ: f32 = MAX_VELOCITY * MAX_VELOCITY;
    /// Threshold below which velocity is negligible (near-stationary). ACE: 0.25 m/s
    pub const SMALL_VELOCITY: f32 = 0.25;
    /// Squared small velocity.
    pub const SMALL_VELOCITY_SQ: f32 = SMALL_VELOCITY * SMALL_VELOCITY;
    /// Minimum time step (30 FPS). ACE: 1/30 s
    pub const MIN_QUANTUM: f32 = 1.0 / 30.0;
    /// Maximum stable time step (10 FPS). ACE: 0.1 s
    pub const MAX_QUANTUM: f32 = 0.1;
    /// Frame-hitch threshold (dropped). ACE: 2.0 s
    pub const HUGE_QUANTUM: f32 = 2.0;
    /// Walkable surface allowance when landing (Z-component threshold). ACE: 0.0871557
    pub const LANDING_Z: f32 = 0.0871557;
    /// Normal.Z threshold for a surface to be classified as "walkable". ACE: 0.66417414618662751
    pub const FLOOR_Z: f32 = 0.66417414618662751;
    /// Radius of the dummy sphere (point-like objects). ACE: 0.1 m
    pub const DUMMY_SPHERE_RADIUS: f32 = 0.1;
    /// Default step height for stepping up/down. ACE: 0.01 m
    pub const DEFAULT_STEP_HEIGHT: f32 = 0.01;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_state_values_match_ace() {
        assert_eq!(TransitionState::Invalid as u8, 0x0);
        assert_eq!(TransitionState::OK as u8, 0x1);
        assert_eq!(TransitionState::Collided as u8, 0x2);
        assert_eq!(TransitionState::Adjusted as u8, 0x3);
        assert_eq!(TransitionState::Slid as u8, 0x4);
    }

    #[test]
    fn transition_state_predicates() {
        assert!(TransitionState::OK.is_ok());
        assert!(!TransitionState::Invalid.is_ok());
        assert!(TransitionState::Collided.is_collided());
        assert!(TransitionState::Adjusted.is_adjusted());
        assert!(TransitionState::Slid.is_slid());
        assert!(!TransitionState::OK.is_collided());
    }

    #[test]
    fn physics_globals_match_ace() {
        assert_eq!(physics_globals::EPSILON, 0.0002);
        assert_eq!(physics_globals::EPSILON_SQ, 0.0002 * 0.0002);
        assert_eq!(physics_globals::GRAVITY, -9.8);
        assert_eq!(physics_globals::FLOOR_Z, 0.66417414618662751);
        assert_eq!(physics_globals::LANDING_Z, 0.0871557);
        assert_eq!(physics_globals::MAX_VELOCITY, 50.0);
        assert_eq!(physics_globals::MAX_VELOCITY_SQ, 2500.0);
        assert_eq!(physics_globals::SMALL_VELOCITY, 0.25);
        assert_eq!(physics_globals::SMALL_VELOCITY_SQ, 0.0625);
        assert_eq!(physics_globals::MIN_QUANTUM, 1.0 / 30.0);
        assert_eq!(physics_globals::MAX_QUANTUM, 0.1);
        assert_eq!(physics_globals::HUGE_QUANTUM, 2.0);
        assert_eq!(physics_globals::DEFAULT_FRICTION, 0.95);
        assert_eq!(physics_globals::MAX_ELASTICITY, 0.1);
        assert_eq!(physics_globals::DUMMY_SPHERE_RADIUS, 0.1);
        assert_eq!(physics_globals::DEFAULT_STEP_HEIGHT, 0.01);
    }
}
