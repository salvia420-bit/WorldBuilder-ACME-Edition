//! Player-vs-entity collision clamping.
//!
//! Sibling to [`super::physics::clamp_delta_against_cell_walls`]
//! (which clamps against indoor cell geometry) and
//! [`super::physics::clamp_delta_against_buildings`] (which clamps
//! against outdoor building AABBs). This module fills the missing
//! third axis: dynamic and static *entities* — other players,
//! creatures, items on the ground, scenery weenies — so the player
//! can't walk through them.
//!
//! ACE's `PhysicsObj.find_object_collisions`
//! (`Source/ACE.Server/Physics/PhysicsObj.cs:~410`) is the reference
//! implementation. It branches on flags from `acclient.h` enum
//! `PhysicsState` (`~/ac-headers/acclient.h`):
//!
//! - `HAS_PHYSICS_BSP` selects per-polygon BSP collision against the
//!   entity's GfxObj BSP tree (precise).
//! - Absence of `HAS_PHYSICS_BSP` falls back to cylsphere/sphere
//!   bounds derived from the entity's setup model (approximate).
//! - `ETHEREAL` or `IGNORE_COLLISIONS` skip collision entirely; the
//!   caller is expected to filter via [`crate::entity::Entity::
//!   is_collidable`] before building [`EntityCollider`] records.
//! - `MISSILE` triggers a separate branch in ACE (missile-vs-target
//!   semantics differ from creature-vs-environment); not modelled
//!   here yet.
//!
//! This module owns the cylinder fallback path today. The BSP path
//! is gated by [`EntityCollider::has_physics_bsp`] but currently
//! falls through to cylinder — wiring up GfxObj BSP traversal is a
//! follow-on. The gate is recorded explicitly so the eventual swap
//! is a single function-call substitution rather than a refactor.

use holtburger_common::Vector3;
use holtburger_common::position::WorldPosition;

/// A collidable entity reduced to the data the collision math needs.
///
/// Construct from a live [`crate::entity::Entity`] after filtering on
/// [`crate::entity::Entity::is_collidable`]. Keeping this separate
/// from `Entity` lets the math layer stay free of `holtburger-protocol`
/// types and lets unit tests build synthetic colliders without
/// constructing full entities.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EntityCollider {
    /// Global world-space XY centre of the entity. (Z is ignored
    /// for the current cylinder check — the player capsule and
    /// entity cylinder are both assumed floor-to-ceiling for AC's
    /// 1.8m-tall actors. The BSP path will reintroduce Z.)
    pub center_xy: (f32, f32),
    /// Lateral half-width of the entity's collision cylinder. ACE
    /// derives this from `PartArray.GetCylSphere()[0].Radius * Scale`
    /// (or `GetSphere()[0].Radius` when no cylsphere is present) per
    /// `PhysicsObj.cs:~595` in `GetPhysicsRadius`. Callers without
    /// a resolved gfx_obj radius may use a default such as
    /// [`crate::spatial::PLAYER_CAPSULE_RADIUS`].
    pub radius: f32,
    /// Whether the source entity has `PhysicsState::HAS_PHYSICS_BSP`
    /// set. Reserved for the future BSP-polygon path; cylinder
    /// fallback runs unconditionally today.
    pub has_physics_bsp: bool,
}

/// A7-R6 (2026-06-12, survey A7 §3 row 9): the static overlap test the
/// ethereal-expiry re-check runs — retail
/// `CPhysicsObj::ethereal_check_for_collisions` sweeps the object's
/// shadow cells with `CObjCell::check_collisions`
/// (`acclient.c:317832-317866`); our entity model is the same lateral
/// XY cylinder [`clamp_delta_against_entities`] uses, so the overlap is
/// a circle-vs-circle test in global XY.
pub fn spheres_overlap_xy(
    center_a: (f32, f32),
    radius_a: f32,
    center_b: (f32, f32),
    radius_b: f32,
) -> bool {
    let dx = center_a.0 - center_b.0;
    let dy = center_a.1 - center_b.1;
    let reach = radius_a + radius_b;
    dx * dx + dy * dy < reach * reach
}

/// Clamp `delta` so the player's lateral motion does not penetrate
/// any [`EntityCollider`]. Returns the clamped delta. `delta.z` is
/// preserved unchanged (entity collision is lateral only).
///
/// Callers in `crates/holtburger-core/src/client/movement/system.rs`
/// are expected to have:
/// 1. Filtered the entity list via
///    [`crate::entity::Entity::is_collidable`] so this function never
///    sees `ETHEREAL` or `IGNORE_COLLISIONS` entities.
/// 2. Skipped self-collision (the player's own GUID).
/// 3. Resolved per-entity `radius` from the gfx_obj sorting sphere
///    or a default for headless test paths.
///
/// Returns `delta` unchanged when no entity is in the swept path or
/// when the proposed motion is below the lateral epsilon.
///
/// Sibling to [`super::physics::clamp_delta_against_cell_walls`]; the
/// integrator can chain both clamps (cell walls first, then
/// entities, since walls are static and rarely overlap entities).
pub fn clamp_delta_against_entities(
    colliders: &[EntityCollider],
    pose: &WorldPosition,
    delta: Vector3,
    player_radius: f32,
) -> Vector3 {
    let lateral_len_sq = delta.x * delta.x + delta.y * delta.y;
    if lateral_len_sq < 1e-12 {
        return delta;
    }
    let lateral_len = lateral_len_sq.sqrt();

    let global = pose.global_coords();
    let start = (global.x, global.y);
    let end = (global.x + delta.x, global.y + delta.y);

    let mut earliest_t = 1.0_f32;
    let mut earliest_normal: Option<(f32, f32)> = None;

    for col in colliders {
        // TODO(acclient.h gap): when `col.has_physics_bsp` is true,
        // dispatch to a BSP-polygon swept test against the entity's
        // GfxObj BSP tree. ACE branches here at `PhysicsObj.cs:412`.
        // For now both paths reduce to swept-circle-vs-circle, which
        // matches ACE's cylsphere fallback for `!HasPhysicsBSP`.
        let combined_r = col.radius + player_radius;
        let Some(t_contact) = sweep_circle_into_circle(start, end, col.center_xy, combined_r)
        else {
            continue;
        };
        if t_contact < earliest_t {
            earliest_t = t_contact;
            let contact_x = start.0 + delta.x * t_contact;
            let contact_y = start.1 + delta.y * t_contact;
            let nx = contact_x - col.center_xy.0;
            let ny = contact_y - col.center_xy.1;
            let nlen = (nx * nx + ny * ny).sqrt().max(1e-6);
            earliest_normal = Some((nx / nlen, ny / nlen));
        }
    }

    let Some((nx, ny)) = earliest_normal else {
        return delta;
    };

    // Back off a hair so the next frame doesn't start inside the
    // cylinder. 1mm in world space, scaled by the motion's pace.
    let backoff = (1e-3 / lateral_len).min(earliest_t);
    let safe_t = (earliest_t - backoff).max(0.0);
    let stopped_x = delta.x * safe_t;
    let stopped_y = delta.y * safe_t;

    // Slide along the tangent: project remaining motion onto the
    // direction perpendicular to the outward normal. Matches the
    // single-iteration slide in `clamp_delta_against_buildings`.
    let remaining_frac = 1.0 - safe_t;
    let remaining_x = delta.x * remaining_frac;
    let remaining_y = delta.y * remaining_frac;
    let into_normal = remaining_x * nx + remaining_y * ny;
    let slide_x = remaining_x - nx * into_normal;
    let slide_y = remaining_y - ny * into_normal;

    Vector3::new(stopped_x + slide_x, stopped_y + slide_y, delta.z)
}

/// Earliest `t` in `[0,1]` where a point swept linearly from `start`
/// to `end` first enters distance `radius` of `center`. Returns
/// `Some(0.0)` when `start` is already inside (penetrating contact).
/// `None` when the swept segment never reaches the circle.
fn sweep_circle_into_circle(
    start: (f32, f32),
    end: (f32, f32),
    center: (f32, f32),
    radius: f32,
) -> Option<f32> {
    let dx = end.0 - start.0;
    let dy = end.1 - start.1;
    let fx = start.0 - center.0;
    let fy = start.1 - center.1;

    // Solve |start + t*d - center|^2 = radius^2 for the smallest
    // t in [0,1]. Expands to: a*t^2 + 2*b*t + c = 0 where
    //   a = d.d, b = f.d, c = f.f - r^2.
    let a = dx * dx + dy * dy;
    if a < 1e-12 {
        let dist_sq = fx * fx + fy * fy;
        return (dist_sq <= radius * radius).then_some(0.0);
    }
    let b = fx * dx + fy * dy;
    let c = fx * fx + fy * fy - radius * radius;

    if c <= 0.0 {
        // Start point already inside the radius shell.
        return Some(0.0);
    }
    let disc = b * b - a * c;
    if disc < 0.0 {
        return None;
    }
    let sqrt_disc = disc.sqrt();
    // Smaller root is the entry; larger is the exit.
    let t_enter = (-b - sqrt_disc) / a;
    (0.0..=1.0).contains(&t_enter).then_some(t_enter)
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Guid;
    use holtburger_common::position::WorldPosition;

    fn pose_at(x: f32, y: f32) -> WorldPosition {
        // Single landblock at origin, local coords = global coords.
        WorldPosition {
            landblock_id: Guid::from(0x0000_0000u32),
            coords: Vector3::new(x, y, 0.0),
            rotation: holtburger_common::Quaternion::identity(),
        }
    }

    #[test]
    fn empty_collider_list_returns_delta_unchanged() {
        let delta = Vector3::new(1.0, 0.0, 0.0);
        let out = clamp_delta_against_entities(&[], &pose_at(0.0, 0.0), delta, 0.4);
        assert_eq!(out, delta);
    }

    #[test]
    fn zero_lateral_motion_passes_through() {
        let colliders = [EntityCollider {
            center_xy: (0.0, 0.0),
            radius: 1.0,
            has_physics_bsp: false,
        }];
        let delta = Vector3::new(0.0, 0.0, -0.5);
        let out = clamp_delta_against_entities(&colliders, &pose_at(0.0, 0.0), delta, 0.4);
        assert_eq!(out, delta);
    }

    #[test]
    fn motion_away_from_entity_unchanged() {
        let colliders = [EntityCollider {
            center_xy: (5.0, 0.0),
            radius: 1.0,
            has_physics_bsp: false,
        }];
        let delta = Vector3::new(-1.0, 0.0, 0.0);
        let out = clamp_delta_against_entities(&colliders, &pose_at(0.0, 0.0), delta, 0.4);
        assert_eq!(out, delta);
    }

    #[test]
    fn head_on_collision_stops_short_of_entity() {
        // Player at origin, entity 3m east with radius 1.0, player
        // radius 0.4 → contact at distance 1.4 → t = 1.6/2.0 = 0.8.
        let colliders = [EntityCollider {
            center_xy: (3.0, 0.0),
            radius: 1.0,
            has_physics_bsp: false,
        }];
        let delta = Vector3::new(2.0, 0.0, 0.0);
        let out = clamp_delta_against_entities(&colliders, &pose_at(0.0, 0.0), delta, 0.4);
        // Expect lateral travel = 0.8 * 2.0 = 1.6, minus a 1mm
        // back-off → ~1.599. Y/Z unchanged. No tangential slide
        // (motion is along the normal).
        assert!(out.x < 1.6, "stopped early: x={}", out.x);
        assert!(out.x > 1.59, "stopped too early: x={}", out.x);
        assert!(out.y.abs() < 1e-3, "y leaked: y={}", out.y);
        assert_eq!(out.z, 0.0);
    }

    #[test]
    fn grazing_motion_slides_along_tangent() {
        // Player at (0,0) moving (4,0). Entity at (2, -1.2)
        // radius 1.0 + player 0.4 = combined 1.4. The straight line
        // y=0 passes within 1.2 of the centre → swept circle clips.
        let colliders = [EntityCollider {
            center_xy: (2.0, -1.2),
            radius: 1.0,
            has_physics_bsp: false,
        }];
        let delta = Vector3::new(4.0, 0.0, 0.0);
        let out = clamp_delta_against_entities(&colliders, &pose_at(0.0, 0.0), delta, 0.4);
        // Expect some forward travel + a positive-y slide kick away
        // from the entity's centre at (2, -1.2).
        assert!(out.x > 0.5, "no forward travel: x={}", out.x);
        assert!(out.y > 0.0, "no tangential slide away from entity: y={}", out.y);
    }

    #[test]
    fn already_penetrating_entity_stops_immediately() {
        // Player at (0,0) but the entity's combined radius engulfs
        // the start point — degenerate but realistic for entities
        // that just spawned on top of the player.
        let colliders = [EntityCollider {
            center_xy: (0.1, 0.0),
            radius: 1.0,
            has_physics_bsp: false,
        }];
        let delta = Vector3::new(1.0, 0.0, 0.0);
        let out = clamp_delta_against_entities(&colliders, &pose_at(0.0, 0.0), delta, 0.4);
        // Already inside → safe_t = 0 (minus backoff clamped at 0)
        // → stopped lateral, slide projects remaining onto tangent.
        // The normal points from entity centre (0.1, 0) → contact
        // ≈ start (0,0), so normal ≈ (-1, 0). Slide of (1,0)
        // perpendicular to (-1,0) is (0,0). Expect ~zero lateral.
        assert!(out.x.abs() < 0.05, "should be ~zero, got x={}", out.x);
        assert!(out.y.abs() < 0.05, "should be ~zero, got y={}", out.y);
    }

    #[test]
    fn picks_earliest_of_two_entities() {
        // Two entities at increasing distance; earlier one should
        // be the contact.
        let colliders = [
            EntityCollider {
                center_xy: (5.0, 0.0),
                radius: 0.5,
                has_physics_bsp: false,
            },
            EntityCollider {
                center_xy: (2.0, 0.0),
                radius: 0.5,
                has_physics_bsp: false,
            },
        ];
        let delta = Vector3::new(4.0, 0.0, 0.0);
        let out = clamp_delta_against_entities(&colliders, &pose_at(0.0, 0.0), delta, 0.4);
        // Closer entity: contact at distance 2 - (0.5+0.4) = 1.1.
        // Travel along delta of length 4 → t = 1.1/4 = 0.275.
        // Lateral out ≈ 1.1 - 1e-3 ≈ 1.099.
        assert!(out.x < 1.11 && out.x > 1.09, "x={}", out.x);
    }

    #[test]
    fn has_physics_bsp_flag_does_not_change_current_behavior() {
        // BSP path is a TODO; cylinder fallback runs regardless.
        // Test exists to lock that behavior in until BSP is wired.
        let mut col = EntityCollider {
            center_xy: (3.0, 0.0),
            radius: 1.0,
            has_physics_bsp: false,
        };
        let delta = Vector3::new(2.0, 0.0, 0.0);
        let pose = pose_at(0.0, 0.0);
        let out_off = clamp_delta_against_entities(&[col], &pose, delta, 0.4);
        col.has_physics_bsp = true;
        let out_on = clamp_delta_against_entities(&[col], &pose, delta, 0.4);
        assert_eq!(out_off, out_on);
    }
}
