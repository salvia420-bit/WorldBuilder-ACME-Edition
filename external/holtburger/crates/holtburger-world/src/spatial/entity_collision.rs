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
//! COL-03 (2026-07-27): the `HAS_PHYSICS_BSP` branch is live. When an
//! entity carries the flag AND its SetupModel physics polygons are
//! resident ([`EntityCollider::bsp`]), the mover's sphere stack is
//! swept against those polygons IN THE ENTITY'S FRAME instead of
//! against a circle at the entity origin. The circle arm stays as the
//! fallback for every entity whose geometry has not landed — the
//! polygons come out of the DATs asynchronously, so absence is normal
//! and must never panic or block spuriously.
//!
//! Why this matters, from the bisect that produced it: the Holtburg
//! grocer door's collider was a swept circle at the door's ORIGIN, so
//! only a perfectly head-on approach (slide component exactly 0) held.
//! At ±0.45 m lateral the tangent slide walked the mover AROUND the
//! circle and into the shop. The door leaf (`GfxObj 0x010044B5` under
//! Setup `0x020019FF`) is 1.93 m wide and 0.26 m thick — a plane, not
//! a post — and only polygon geometry reproduces "slide ALONG the
//! leaf".

use holtburger_common::position::WorldPosition;
use holtburger_common::{Quaternion, Triangle, Vector3};
use std::sync::Arc;

/// A collidable entity reduced to the data the collision math needs.
///
/// Construct from a live [`crate::entity::Entity`] after filtering on
/// [`crate::entity::Entity::is_collidable`]. Keeping this separate
/// from `Entity` lets the math layer stay free of `holtburger-protocol`
/// types and lets unit tests build synthetic colliders without
/// constructing full entities.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityCollider {
    /// Global world-space XY centre of the entity. (Z is ignored by
    /// the cylinder arm — the player capsule and entity cylinder are
    /// both assumed floor-to-ceiling for AC's 1.8m-tall actors. The
    /// BSP arm reads Z from [`EntityCollider::bsp`]'s frame instead.)
    pub center_xy: (f32, f32),
    /// Lateral half-width of the entity's collision cylinder. ACE
    /// derives this from `PartArray.GetCylSphere()[0].Radius * Scale`
    /// (or `GetSphere()[0].Radius` when no cylsphere is present) per
    /// `PhysicsObj.cs:~595` in `GetPhysicsRadius`. Callers without
    /// a resolved gfx_obj radius may use a default such as
    /// [`crate::spatial::PLAYER_CAPSULE_RADIUS`].
    pub radius: f32,
    /// Whether the source entity has `PhysicsState::HAS_PHYSICS_BSP`
    /// set. Selects the BSP arm — but only together with resident
    /// [`Self::bsp`] geometry; the flag alone keeps the cylinder.
    pub has_physics_bsp: bool,
    /// Resident precise geometry + the entity's live world frame.
    /// `Some` only when [`Self::has_physics_bsp`] AND the entity's
    /// SetupModel physics polygons have been staged into
    /// `WorldState::setup_physics_geometry`. `None` keeps the
    /// swept-circle arm — the DAT walk is asynchronous, so a
    /// not-yet-resident entity must degrade, never block or panic.
    pub bsp: Option<EntityBsp>,
}

/// One entity's precise collision geometry bound to its live world
/// frame. Split from [`EntityPhysicsGeometry`] because the geometry is
/// shared per SetupModel (every aluvian house door is the same
/// polygons) while the frame is per entity and moves on the wire.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityBsp {
    /// Setup-local physics triangles, shared across every entity on
    /// this SetupModel.
    pub geometry: Arc<EntityPhysicsGeometry>,
    /// Entity origin in GLOBAL world metres (x/y from
    /// [`EntityCollider::center_xy`], z from the wire pose).
    pub origin: Vector3,
    /// Entity orientation from the wire pose. Unit quaternion; its
    /// conjugate maps world→setup-local, mirroring
    /// [`crate::spatial::CellPhysicsBsp::world_to_local`].
    pub orientation: Quaternion,
}

/// A SetupModel's physics polygons, fan-triangulated, in SETUP-LOCAL
/// metres with each part's frame already composed in.
///
/// Sourced from the same `GfxObj.physics_bsp` + `physics_polygons`
/// pair the static path stages as [`crate::spatial::CellPhysicsBsp`]:
/// the wasm bundle's `walk_setup_parts_with_geom_and_bsp` walks
/// Setup→parts→GfxObj and only a part carrying BOTH a tree and a
/// non-empty polygon map contributes, which is exactly ACE's
/// `GfxObj != null && GfxObj.PhysicsBSP != null` gate in
/// `PhysicsPart.FindObjCollisions` (`PhysicsPart.cs:52`).
///
/// Per-part `default_scale` is baked into the vertices by the walker.
/// Object-level `ObjectDesc` scale is NOT modelled — `Entity` carries
/// no scale today, so every entity uses its SetupModel at 1.0 (ACE's
/// `GfxObjScale.Z` divisor in `SpherePath.CacheLocalSpaceSphere`).
#[derive(Debug, Clone, PartialEq)]
pub struct EntityPhysicsGeometry {
    /// Physics triangles in setup-local metres.
    pub triangles: Vec<Triangle>,
    /// Radius of the setup-local sphere about the setup origin that
    /// bounds `triangles`. The cheap reject before the per-triangle
    /// sweep, standing in for ACE's `GfxObj.PhysicsSphere` overlap
    /// test at `GfxObj.cs:79-82`.
    pub bound_radius: f32,
}

impl EntityPhysicsGeometry {
    /// Build from setup-local triangles, computing the bounding
    /// radius about the setup origin. An empty triangle list yields a
    /// zero radius, which the sweep rejects immediately.
    pub fn from_triangles(triangles: Vec<Triangle>) -> Self {
        let mut bound_sq = 0.0_f32;
        for tri in &triangles {
            for v in [tri.v0, tri.v1, tri.v2] {
                bound_sq = bound_sq.max(v.length_squared());
            }
        }
        Self {
            triangles,
            bound_radius: bound_sq.sqrt(),
        }
    }
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
/// 4. Attached [`EntityCollider::bsp`] for every `HAS_PHYSICS_BSP`
///    entity whose SetupModel physics polygons are resident
///    (`WorldState::entity_physics_bsp`). Colliders without it take
///    the swept-circle arm.
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

    let Some((earliest_t, (nx, ny), hit_bsp)) =
        earliest_entity_contact(colliders, start, global.z, delta, player_radius)
    else {
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

    // Re-test the slide, BSP contacts only. One contact normal cannot
    // describe a corner: at the end of a door leaf the mover touches the
    // leaf face and the end cap in the same step, and sliding along
    // whichever won the tie drives it straight into the other — the
    // leaf is only 0.26 m thick, so that tunnels. Retail re-runs the
    // transition on the slid vector (`CTransition::transition`
    // recursion); we do ONE bounded re-test that can only shorten the
    // slide, never redirect it. Confined to the BSP arm on purpose: the
    // circle arm's stop-then-creep is the long-standing behaviour for
    // creatures and players and stays bit-identical.
    let slide_len_sq = slide_x * slide_x + slide_y * slide_y;
    let (slide_x, slide_y) = if !hit_bsp {
        (slide_x, slide_y)
    } else if slide_len_sq < 1e-12 {
        (0.0, 0.0)
    } else {
        let slide_start = (start.0 + stopped_x, start.1 + stopped_y);
        let slide_delta = Vector3::new(slide_x, slide_y, 0.0);
        match earliest_entity_contact(colliders, slide_start, global.z, slide_delta, player_radius)
        {
            Some((t2, _, _)) => {
                let slide_len = slide_len_sq.sqrt();
                let backoff2 = (1e-3 / slide_len).min(t2);
                let safe_t2 = (t2 - backoff2).max(0.0);
                (slide_x * safe_t2, slide_y * safe_t2)
            }
            None => (slide_x, slide_y),
        }
    };

    Vector3::new(stopped_x + slide_x, stopped_y + slide_y, delta.z)
}

/// Earliest `(t, outward XY normal, came_from_bsp)` over every collider
/// for a lateral sweep of `delta` from `start` (global XY) at feet height
/// `feet_z`. `None` when nothing is struck inside `[0, 1)`.
fn earliest_entity_contact(
    colliders: &[EntityCollider],
    start: (f32, f32),
    feet_z: f32,
    delta: Vector3,
    player_radius: f32,
) -> Option<(f32, (f32, f32), bool)> {
    let end = (start.0 + delta.x, start.1 + delta.y);
    let mut earliest_t = 1.0_f32;
    let mut earliest_normal: Option<((f32, f32), bool)> = None;
    for col in colliders {
        // ACE `PhysicsObj.FindObjCollisions` branches here
        // (`Source/ACE.Server/Physics/PhysicsObj.cs:412`): with
        // `HasPhysicsBSP` the test descends
        // `PartArray → PhysicsPart → GfxObj.FindObjCollisions →
        // BSPTree.find_collisions` over the part's physics polygons in
        // the PART frame; without it, the cylsphere/sphere bounds. Our
        // polygons arrive out of the DATs asynchronously, so a
        // BSP-flagged entity whose geometry has not landed keeps the
        // bounds arm rather than becoming non-solid.
        let (contact, from_bsp) = match &col.bsp {
            Some(bsp) if col.has_physics_bsp => (
                sweep_capsule_into_entity_bsp(bsp, start, feet_z, delta, player_radius),
                true,
            ),
            _ => {
                let combined_r = col.radius + player_radius;
                let hit = sweep_circle_into_circle(start, end, col.center_xy, combined_r).map(|t| {
                    let contact_x = start.0 + delta.x * t;
                    let contact_y = start.1 + delta.y * t;
                    let nx = contact_x - col.center_xy.0;
                    let ny = contact_y - col.center_xy.1;
                    let nlen = (nx * nx + ny * ny).sqrt().max(1e-6);
                    (t, (nx / nlen, ny / nlen))
                });
                (hit, false)
            }
        };
        let Some((t_contact, normal)) = contact else {
            continue;
        };
        if t_contact < earliest_t {
            earliest_t = t_contact;
            earliest_normal = Some((normal, from_bsp));
        }
    }
    earliest_normal.map(|(n, from_bsp)| (earliest_t, n, from_bsp))
}

/// COL-03 — the `HAS_PHYSICS_BSP` arm. Sweeps the mover's sphere stack
/// against one entity's physics polygons IN THE ENTITY'S FRAME and
/// returns `(t, outward XY normal)` for the earliest contact, or `None`
/// for a clean miss.
///
/// Maps to ACE `PhysicsObj.FindObjCollisions` (`PhysicsObj.cs:412`) →
/// `PartArray.FindObjCollisions` → `PhysicsPart.FindObjCollisions`
/// (`PhysicsPart.cs:52`, which calls
/// `SpherePath.CacheLocalSpaceSphere(Pos, GfxObjScale.Z)` — the
/// world→part transform reproduced here) → `GfxObj.FindObjCollisions`
/// (`GfxObj.cs:73`, bounding-sphere reject then the tree walk). Our
/// walk is a swept-sphere solve over the same resolved polygons rather
/// than `BSPTree.find_collisions`: the tree is an acceleration
/// structure over exactly this polygon set, and the swept solver is the
/// one already validated for cell/static geometry
/// ([`super::physics::sweep_sphere_against_triangles`]). It yields the
/// time of first contact plus the surface normal, which is what the
/// slide below needs; the ACE tree walk's own output is the same pair.
///
/// Lateral-only, matching the rest of this module: the sweep holds z at
/// the mover's entry height. Sphere centres are the retail Setup
/// `0x02000001` stack ([`super::transition::PLAYER_SETUP_SPHERE_LOW_Z`]
/// / `_HIGH_Z`) above `feet_z`, at the caller's `player_radius`.
///
/// A contact whose surface normal is (near-)vertical is dropped: a
/// floor/ceiling polygon cannot obstruct lateral motion, and its
/// degenerate XY normal would produce a nonsense slide.
fn sweep_capsule_into_entity_bsp(
    bsp: &EntityBsp,
    start: (f32, f32),
    feet_z: f32,
    delta: Vector3,
    player_radius: f32,
) -> Option<(f32, (f32, f32))> {
    let geometry = &bsp.geometry;
    if geometry.triangles.is_empty() {
        return None;
    }
    let inv = bsp.orientation.conjugate();
    let lateral = Vector3::new(delta.x, delta.y, 0.0);
    let mut best: Option<(f32, (f32, f32))> = None;
    for centre_z in [
        super::transition::PLAYER_SETUP_SPHERE_LOW_Z,
        super::transition::PLAYER_SETUP_SPHERE_HIGH_Z,
    ] {
        let world_start = Vector3::new(start.0, start.1, feet_z + centre_z);
        let local_start = inv.rotate_vector(world_start - bsp.origin);
        let local_end = local_start + inv.rotate_vector(lateral);
        // `GfxObj.FindObjCollisions`'s bounding-sphere reject, applied
        // to the whole swept segment instead of per end-point.
        let reach = geometry.bound_radius + player_radius;
        if segment_distance_to_origin_sq(local_start, local_end) > reach * reach {
            continue;
        }
        let Some(hit) = super::physics::sweep_sphere_against_triangles(
            &geometry.triangles,
            local_start,
            local_end,
            player_radius,
        ) else {
            continue;
        };
        let world_normal = bsp.orientation.rotate_vector(hit.normal);
        let nlen = (world_normal.x * world_normal.x + world_normal.y * world_normal.y).sqrt();
        if nlen < 1e-4 {
            continue;
        }
        let normal = (world_normal.x / nlen, world_normal.y / nlen);
        if best.is_none_or(|(t, _)| hit.t < t) {
            best = Some((hit.t.clamp(0.0, 1.0), normal));
        }
    }
    best
}

/// Squared distance from the origin to the segment `a`→`b`. The
/// bounding-sphere reject's inner loop; a segment-vs-sphere test rather
/// than two point tests so a long sweep that passes the geometry
/// mid-step is not rejected.
fn segment_distance_to_origin_sq(a: Vector3, b: Vector3) -> f32 {
    let ab = b - a;
    let len_sq = ab.length_squared();
    if len_sq < 1e-12 {
        return a.length_squared();
    }
    let t = (-(a.dot(&ab)) / len_sq).clamp(0.0, 1.0);
    (a + ab * t).length_squared()
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
            bsp: None,
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
            bsp: None,
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
            bsp: None,
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
            bsp: None,
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
            bsp: None,
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
                bsp: None,
            },
            EntityCollider {
                center_xy: (2.0, 0.0),
                radius: 0.5,
                has_physics_bsp: false,
                bsp: None,
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
    fn has_physics_bsp_flag_without_resident_geometry_keeps_cylinder() {
        // The flag alone must NOT change anything: geometry arrives out
        // of the DATs asynchronously, and a BSP-flagged entity whose
        // polygons have not landed has to stay solid on the bounds arm
        // rather than turn non-solid.
        let mut col = EntityCollider {
            center_xy: (3.0, 0.0),
            radius: 1.0,
            has_physics_bsp: false,
            bsp: None,
        };
        let delta = Vector3::new(2.0, 0.0, 0.0);
        let pose = pose_at(0.0, 0.0);
        let out_off = clamp_delta_against_entities(&[col.clone()], &pose, delta, 0.4);
        col.has_physics_bsp = true;
        let out_on = clamp_delta_against_entities(&[col], &pose, delta, 0.4);
        assert_eq!(out_off, out_on);
    }

    // ---- COL-03: the HAS_PHYSICS_BSP arm ----------------------------
    //
    // Synthetic leaf standing in for the aluvian house door's part 0
    // (`GfxObj 0x010044B5`): a slab 2 m wide in setup-local x, 0.2 m
    // thick in y, 2.5 m tall. The real-DAT + real-placement regression
    // (head-on plus the ±0.45 m lateral approaches the bisect proved
    // were never blocked) lives in `apps/holtburger-web/src/lib.rs`
    // `mod tests_entity_bsp_door_collision`, where the SetupModel walk
    // that produces this geometry is available.

    /// Leaf slab centred on the setup origin: |x| ≤ half_width,
    /// 0 ≤ y ≤ thickness, 0 ≤ z ≤ height. Only the two large faces are
    /// emitted — enough for a lateral sweep, and it keeps the expected
    /// normals unambiguous.
    fn leaf_geometry(half_width: f32, thickness: f32, height: f32) -> Arc<EntityPhysicsGeometry> {
        let v = |x: f32, y: f32, z: f32| Vector3::new(x, y, z);
        let tris = vec![
            // South face (outward normal −y).
            Triangle::new(v(-half_width, 0.0, 0.0), v(half_width, 0.0, height), v(half_width, 0.0, 0.0)),
            Triangle::new(v(-half_width, 0.0, 0.0), v(-half_width, 0.0, height), v(half_width, 0.0, height)),
            // North face (outward normal +y).
            Triangle::new(v(-half_width, thickness, 0.0), v(half_width, thickness, 0.0), v(half_width, thickness, height)),
            Triangle::new(v(-half_width, thickness, 0.0), v(half_width, thickness, height), v(-half_width, thickness, height)),
        ];
        Arc::new(EntityPhysicsGeometry::from_triangles(tris))
    }

    /// Rotation of `theta` about world z — the only axis a wire pose
    /// uses for a door. (`Quaternion::from_heading` takes an AC heading,
    /// not a raw angle, so it would read backwards here.)
    fn rot_z(theta: f32) -> Quaternion {
        Quaternion {
            w: (theta * 0.5).cos(),
            x: 0.0,
            y: 0.0,
            z: (theta * 0.5).sin(),
        }
    }

    fn leaf_collider(center: (f32, f32), heading: Quaternion) -> EntityCollider {
        EntityCollider {
            center_xy: center,
            radius: 0.1,
            has_physics_bsp: true,
            bsp: Some(EntityBsp {
                geometry: leaf_geometry(1.0, 0.2, 2.5),
                origin: Vector3::new(center.0, center.1, 0.0),
                orientation: heading,
            }),
        }
    }

    #[test]
    fn bsp_arm_blocks_head_on_approach() {
        let col = leaf_collider((0.0, 3.0), Quaternion::identity());
        let delta = Vector3::new(0.0, 4.0, 0.0);
        let out = clamp_delta_against_entities(&[col], &pose_at(0.0, 0.0), delta, 0.48);
        // Leaf south face at y = 3; contact at 3 − 0.48 = 2.52, minus
        // the 1 mm back-off.
        assert!(out.y < 2.52, "did not stop short of the leaf: y={}", out.y);
        assert!(out.y > 2.5, "stopped too early: y={}", out.y);
    }

    /// Repeated short steps due north, the offline mirror of the bisect
    /// rig's `door_sweep.cjs` walk (hold W, sample the pose). One clamp
    /// call cannot show the defect — creeping around a circle takes a
    /// second of frames, which is exactly why the 07-20 one-shot A/B and
    /// the head-on live measurement both passed while the feature was
    /// broken.
    fn walk_north(col: &EntityCollider, start_x: f32, steps: usize) -> (f32, f32) {
        let mut p = (start_x, 0.0_f32);
        for _ in 0..steps {
            let out = clamp_delta_against_entities(
                std::slice::from_ref(col),
                &pose_at(p.0, p.1),
                Vector3::new(0.0, 0.2, 0.0),
                0.48,
            );
            p = (p.0 + out.x, p.1 + out.y);
        }
        p
    }

    #[test]
    fn bsp_arm_blocks_lateral_offset_walk_that_circle_arm_slides_around() {
        // THE COL-03 regression. ±0.45 m off the entity origin the
        // circle arm's tangent slide walks the mover AROUND the collider
        // (bisect `results/sweep2.json`: both offsets ended inside the
        // shop, env-cell 0x16A). The leaf is 2 m wide, so the BSP arm
        // has to stop dead and stay stopped.
        for offset in [-0.45_f32, 0.45] {
            let col = leaf_collider((0.0, 3.0), Quaternion::identity());
            let end = walk_north(&col, offset, 30);
            assert!(
                end.1 < 2.53,
                "offset {offset}: leaf did not hold the walk (y={})",
                end.1
            );
            assert!(
                (end.0 - offset).abs() < 0.05,
                "offset {offset}: mover crept laterally to x={}",
                end.0
            );

            // Same walk on the circle arm (combined radius
            // 0.1 + 0.48 = 0.58): contact registers, then the tangent
            // slide carries the mover clear of the disc and north past
            // the door plane.
            let mut circle = col;
            circle.bsp = None;
            let end_circle = walk_north(&circle, offset, 30);
            assert!(
                end_circle.1 > 3.0,
                "offset {offset}: circle arm was expected to slide around \
                 and pass the door plane, but ended at y={}",
                end_circle.1
            );
        }
    }

    #[test]
    fn head_on_walk_blocks_on_both_arms() {
        // The degenerate geometry the 07-20 "live functional block" and
        // the offline A/B both measured: slide component exactly 0, so
        // the circle arm holds too. Kept so the regression suite still
        // covers it — it just cannot be the only case.
        let col = leaf_collider((0.0, 3.0), Quaternion::identity());
        let end = walk_north(&col, 0.0, 30);
        assert!(end.1 < 2.53, "BSP arm let the head-on walk through: {end:?}");
        let mut circle = col;
        circle.bsp = None;
        let end_circle = walk_north(&circle, 0.0, 30);
        assert!(
            end_circle.1 < 2.53,
            "circle arm let the head-on walk through: {end_circle:?}"
        );
    }

    #[test]
    fn bsp_arm_slide_runs_along_the_leaf_plane_not_around_a_circle() {
        // Oblique push into the leaf: the residual must run ALONG the
        // leaf axis (+x here) and leave the mover south of the face
        // plane. The circle arm deflects along the radius from the
        // entity origin instead and ends up north of the leaf.
        let col = leaf_collider((0.0, 3.0), Quaternion::identity());
        let delta = Vector3::new(1.0, 4.0, 0.0);
        let out = clamp_delta_against_entities(
            std::slice::from_ref(&col),
            &pose_at(-0.45, 0.0),
            delta,
            0.48,
        );
        assert!(
            out.y < 2.52,
            "BSP arm let the oblique push through the face: y={}",
            out.y
        );
        assert!(
            out.x > 0.3,
            "no along-leaf slide: x={} (expected the residual to run +x)",
            out.x
        );
        let mut circle = col;
        circle.bsp = None;
        let out_circle =
            clamp_delta_against_entities(std::slice::from_ref(&circle), &pose_at(-0.45, 0.0), delta, 0.48);
        assert!(
            out_circle.y > 2.52,
            "circle arm was expected to deflect past the leaf plane, y={}",
            out_circle.y
        );
    }

    #[test]
    fn bsp_arm_respects_the_entity_orientation() {
        // The sweep runs in the ENTITY's frame, so a rotated leaf has to
        // block along its own normal. 45° about z is the real grocer
        // door's placement quaternion (w 0.923879, z 0.382684).
        let heading = rot_z(std::f32::consts::FRAC_PI_4);
        let col = leaf_collider((0.0, 0.0), heading);
        // 2.828 m out along the leaf's local −y axis, closing head-on.
        let dir = heading.rotate_vector(Vector3::new(0.0, -1.0, 0.0));
        let start = (dir.x * 2.828, dir.y * 2.828);
        let delta = Vector3::new(-dir.x * 4.0, -dir.y * 4.0, 0.0);
        let out = clamp_delta_against_entities(
            std::slice::from_ref(&col),
            &pose_at(start.0, start.1),
            delta,
            0.48,
        );
        // Contact at 0.48 from the face ⇒ 2.348 m of travel, less the
        // 1 mm back-off. Head-on ⇒ no tangential slide.
        let travelled = (out.x * out.x + out.y * out.y).sqrt();
        assert!(
            (2.33..2.35).contains(&travelled),
            "rotated leaf blocked at the wrong distance: travelled={travelled}"
        );
    }

    #[test]
    fn bsp_arm_lets_a_pass_beyond_the_leaf_edge_through() {
        // The counterpart of the block: 1.6 m off-centre clears the 1 m
        // half-width leaf entirely. The circle arm's phantom disc must
        // not have been left in place behind the geometry.
        let col = leaf_collider((0.0, 3.0), Quaternion::identity());
        let delta = Vector3::new(0.0, 4.0, 0.0);
        let out = clamp_delta_against_entities(&[col], &pose_at(1.6, 0.0), delta, 0.48);
        assert_eq!(out, delta, "clear pass was clamped: {out:?}");
    }

    #[test]
    fn bsp_arm_with_empty_geometry_never_blocks_or_panics() {
        let col = EntityCollider {
            center_xy: (0.0, 3.0),
            radius: 0.1,
            has_physics_bsp: true,
            bsp: Some(EntityBsp {
                geometry: Arc::new(EntityPhysicsGeometry::from_triangles(Vec::new())),
                origin: Vector3::new(0.0, 3.0, 0.0),
                orientation: Quaternion::identity(),
            }),
        };
        let delta = Vector3::new(0.0, 4.0, 0.0);
        let out = clamp_delta_against_entities(&[col], &pose_at(0.0, 0.0), delta, 0.48);
        assert_eq!(out, delta);
    }

    #[test]
    fn bsp_arm_ignores_geometry_above_and_below_the_mover() {
        // A leaf whose slab sits from z 4.0 to 6.5 is overhead: the
        // mover's sphere stack (0.475 / 1.35 above the feet) passes
        // under it untouched.
        let mut col = leaf_collider((0.0, 3.0), Quaternion::identity());
        if let Some(bsp) = col.bsp.as_mut() {
            bsp.origin.z = 4.0;
        }
        let delta = Vector3::new(0.0, 4.0, 0.0);
        let out = clamp_delta_against_entities(&[col], &pose_at(0.0, 0.0), delta, 0.48);
        assert_eq!(out, delta, "overhead geometry blocked lateral motion");
    }
}
