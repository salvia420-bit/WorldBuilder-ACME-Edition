use super::{
    BuildingAabbEntry, ContactState, LocalDriveControl, SelfPlayerDriveProjectionState,
    SolveBodyInput, SolveProjectionBasis, SolvedBodyKinematics, SpatialSampleMode, SpatialScene,
    SpatialSolveBatch, SpatialSolveRequest,
};
use holtburger_common::position::{METERS_PER_LANDBLOCK, WorldPosition};
use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
use std::f32::consts::{PI, TAU};
use std::time::Duration;

const EPSILON: f32 = 1e-4;

/// Physics deep-dive 2026-06-01 (gap: CalcNumSteps substepping) — A/B
/// gate for the cell-wall collision sweep's substep ("collide + slide
/// each sub-segment") loop, DEFAULT-OFF so the shipped single-iteration
/// solver behaviour is bit-for-bit unchanged until this path is
/// validated.
///
/// `false` (DEFAULT): the public wrappers
/// ([`clamp_delta_against_cell_walls`] et al.) call the single-pass
/// [`clamp_delta_against_cell_walls_with_normal`] directly — exactly the
/// pre-2026-06-01 behaviour.
///
/// `true`: the wrappers route through
/// [`clamp_delta_against_cell_walls_substepped`], which subdivides the
/// requested delta into `ceil(dist/radius)` equal sub-segments
/// (retail's non-viewer `Transition.CalcNumSteps`, ACE
/// `Physics/Transition.cs:97-140`) and runs the existing per-step
/// collide+slide on each, advancing a working pose between steps and
/// recomputing the global sweep origin each step. This catches a fast
/// lateral move that the single iteration would let *tunnel* past a
/// thin wall (the sweep mid-point sample can miss), and it lets a long
/// diagonal into a concave (L-shaped) corner slide along the SECOND wall
/// after the first wall clamps the first sub-segment — the single pass
/// stops dead at the first wall.
///
/// `num_steps == 1` (the common case: a per-tick run move ≈ 0.43 m <
/// radius 0.4 m → `dist/radius ≈ 1.07`, so usually 2 steps for a full
/// run tick, 1 step for a slower move) routes through the same per-step
/// call as today and is behaviour-identical, so flipping this on is a
/// pure superset for short moves and only diverges on fast / concave
/// motion — the cases it is meant to fix.
///
/// This is the foundation for the deferred retail `cliff_slide`
/// cross-product skid (`Transition.CliffSlide`,
/// `Physics/Transition.cs:242-266`), which needs the per-step
/// `last_known_contact_plane` this loop now carries across substeps. See
/// the TODO in [`clamp_delta_against_cell_walls_substepped`].
pub const USE_SUBSTEP_TRANSITION: bool = false;

/// Physics deep-dive 2026-06-01 (CalcNumSteps refinements) — A/B gate
/// for 3D-distance-aware substep counting, DEFAULT-OFF so existing
/// behaviour stays bit-for-bit identical until validated.
///
/// `false` (DEFAULT): `clamp_delta_against_cell_walls_substepped` keys the
/// substep count on lateral (XY) distance only — the wall sweep is a swept
/// circle in XY, so Z-motion does not subdivide.
///
/// `true`: include the Z component (`dist = sqrt(dx²+dy²+dz²)`), matching
/// the non-viewer arm of `Transition.CalcNumSteps` (ACE
/// `Physics/Transition.cs:97-140`, `offset.Length()` is full 3D), adding
/// substeps for combined vertical+lateral moves (risers, jumps). No effect
/// on pure lateral moves.
pub const USE_CALCNUMSTEPS_3D_DIST: bool = false;

/// Physics deep-dive 2026-06-01 (cliff_slide Stage-2, intra-substep). Gate
/// for applying the seam-skid (`cliff_slide_residual_along_seam`) WITHIN the
/// [`clamp_delta_against_cell_walls_substepped`] loop, DEFAULT-OFF. When false
/// the loop accumulates `last_normal` and advances the pose exactly as today
/// (the cliff_slide block is skipped, so `final_clamped == clamped_step`).
/// When true, a fast tick crossing two walls skids the seam mid-tick using the
/// previous step's wall (N_last) and the current step's wall (N_new).
pub const USE_CLIFF_SLIDE_INTRA_SUBSTEP: bool = false;

/// Phase 6 step B player-capsule dimensions. ACE derives these from
/// `Setup._dat.Height` / `Setup._dat.Radius` per
/// `external/ACE/Source/ACE.Server/Physics/PartArray.cs:189-206`.
/// Retail human Setup `0x0200_0001` ships radius=0.4, height=1.8;
/// hard-coded here rather than read at runtime to avoid a Setup
/// fetch on every collision tick.
pub const PLAYER_CAPSULE_RADIUS: f32 = 0.4;
pub const PLAYER_CAPSULE_HEIGHT: f32 = 1.8;

/// Physics deep-dive 2026-06-01 (gap 3) — per-object step heights.
/// ACE reads these from `Setup._dat.StepUpHeight`/`StepDownHeight`
/// scaled by `Scale.Z`
/// (`external/ACE/Source/ACE.Server/Physics/PartArray.cs:236-248`:
/// `GetStepUpHeight`/`GetStepDownHeight` return
/// `Setup._dat.StepUpHeight * Scale.Z`, falling back to
/// `PhysicsGlobals.DefaultStepHeight = 0.01` when `Setup == null`).
/// `ObjectInfo` caches them (`ObjectInfo.cs:46-47`) and `Transition`
/// consumes them in the `StepUp`/`StepDown` walkable path
/// (`Transition.cs:761,855`).
///
/// Holtburger parses `SetupModel.step_up`/`step_down`
/// (`crates/holtburger-dat/src/file_type/setup_model.rs:310-311`) but
/// the movement solver never read them — gap 3 in the deep-dive
/// handoff. Like [`PLAYER_CAPSULE_RADIUS`]/[`PLAYER_CAPSULE_HEIGHT`]
/// above, the values are hard-coded here from the real human-body
/// Setup `0x0200_0001` (dumped from the base `client_portal.dat`:
/// `StepUpHeight = 0.6`, `StepDownHeight = 1.5`, with `Scale.Z = 1.0`
/// for the player so the effective heights are unscaled) rather than
/// fetched per collision tick. Wiring the per-setup read for non-player
/// objects is a follow-up — see the module-level step-up/step-down
/// helpers below.
pub const PLAYER_STEP_UP_HEIGHT: f32 = 0.6;
pub const PLAYER_STEP_DOWN_HEIGHT: f32 = 1.5;

/// `PhysicsGlobals.DefaultStepHeight` — the step-height fallback when an
/// object has no Setup (ACE `PartArray.cs:236-248`; retail
/// `CPartArray::GetStepUpHeight`/`GetStepDownHeight`,
/// `acclient.c:325400-325424`, returns `0.01` when `setup_table == 0`).
pub const DEFAULT_STEP_HEIGHT: f32 = 0.01;

/// A7-R1 (2026-06-12, survey A7 §3 row 1): the retail per-setup step
/// heights — `Setup.StepUpHeight × Scale.Z` / `StepDownHeight × Scale.Z`,
/// each falling back to [`DEFAULT_STEP_HEIGHT`] when the setup carries no
/// value (`acclient.c:325400-325424`, `:314128-314129` ObjectInfo cache;
/// ACE `PartArray.cs:236-248`, `ObjectInfo.cs:46-47`). The human-body
/// player Setup `0x0200_0001` (`step_up = 0.6`, `step_down = 1.5`,
/// `scale.z = 1.0`) resolves to exactly
/// ([`PLAYER_STEP_UP_HEIGHT`], [`PLAYER_STEP_DOWN_HEIGHT`]) so the
/// default player behavior is byte-identical.
pub fn setup_step_heights(
    step_up: Option<f32>,
    step_down: Option<f32>,
    scale_z: f32,
) -> (f32, f32) {
    let up = step_up.map_or(DEFAULT_STEP_HEIGHT, |h| h * scale_z);
    let down = step_down.map_or(DEFAULT_STEP_HEIGHT, |h| h * scale_z);
    (up, down)
}

/// Phase 6 step B: result of a single swept-sphere-vs-AABB query.
/// `t` is the parametric time of first contact in `[0.0, 1.0]`
/// (where 0.0 = start, 1.0 = full delta), `normal` is the
/// AABB-face outward normal at the contact point (used for slide
/// projection on the second sweep iteration), and `entry` carries
/// the building reference for diagnostics / Phase E door-state
/// sliding.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SweptSphereHit {
    pub t: f32,
    pub normal: Vector3,
    pub entry: BuildingAabbEntry,
}

/// Phase 6 step B: sweep a sphere of `radius` along `delta` and
/// return the earliest AABB contact, or `None` for a clean miss.
/// Uses the standard Minkowski-sum trick: inflate every AABB by the
/// sphere radius and ray-cast the sphere centre. `pose.coords` is
/// the start in the AC world frame (note: AABBs are stored in the
/// same global-meters frame as `pose.global_coords`, so the
/// caller's `delta` is consumed directly without per-landblock
/// conversion).
///
/// Implementation note: this is the slab method
/// (Kay-Kajiya / Williams) — for each axis compute t-range for the
/// ray entering and exiting the slab, intersect the three ranges,
/// pick the entry t. Capsule approximation uses sphere-at-chest-
/// height; vertical extent is folded into the AABBs themselves
/// (a 0.5 m roof overhang lookup against a 1.8 m capsule means the
/// AABB's `min.z` is below the player's feet anyway).
pub fn sweep_sphere_against_aabbs(
    candidates: &[BuildingAabbEntry],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
) -> Option<SweptSphereHit> {
    if delta.length_squared() <= 1e-10 || candidates.is_empty() {
        return None;
    }
    let start = pose.global_coords();
    let mut best: Option<SweptSphereHit> = None;
    for entry in candidates {
        let inflated = entry.aabb.inflate(radius);
        if let Some((t, normal)) = ray_aabb_entry(start, delta, &inflated)
            && (best.is_none() || t < best.unwrap().t)
        {
            best = Some(SweptSphereHit {
                t,
                normal,
                entry: *entry,
            });
        }
    }
    best
}

fn ray_aabb_entry(
    origin: Vector3,
    direction: Vector3,
    aabb: &Aabb,
) -> Option<(f32, Vector3)> {
    let mut t_enter = 0.0f32;
    let mut t_exit = 1.0f32;
    let mut entry_axis: u8 = u8::MAX;
    let mut entry_sign: f32 = 0.0;

    let mins = [aabb.min.x, aabb.min.y, aabb.min.z];
    let maxs = [aabb.max.x, aabb.max.y, aabb.max.z];
    let starts = [origin.x, origin.y, origin.z];
    let dirs = [direction.x, direction.y, direction.z];

    for axis in 0..3 {
        let d = dirs[axis];
        let s = starts[axis];
        let lo = mins[axis];
        let hi = maxs[axis];
        if d.abs() < f32::EPSILON {
            if s < lo || s > hi {
                return None;
            }
            continue;
        }
        let inv_d = 1.0 / d;
        let mut t_lo = (lo - s) * inv_d;
        let mut t_hi = (hi - s) * inv_d;
        let mut sign_for_axis = -1.0f32;
        if t_lo > t_hi {
            std::mem::swap(&mut t_lo, &mut t_hi);
            sign_for_axis = 1.0;
        }
        if t_lo > t_enter {
            t_enter = t_lo;
            entry_axis = axis as u8;
            entry_sign = sign_for_axis;
        }
        if t_hi < t_exit {
            t_exit = t_hi;
        }
        if t_enter > t_exit {
            return None;
        }
    }

    if t_enter >= 1.0 || t_enter < 0.0 {
        return None;
    }
    if entry_axis == u8::MAX {
        return None;
    }
    let normal = match entry_axis {
        0 => Vector3::new(entry_sign, 0.0, 0.0),
        1 => Vector3::new(0.0, entry_sign, 0.0),
        _ => Vector3::new(0.0, 0.0, entry_sign),
    };
    Some((t_enter, normal))
}

/// BSP M1 (pure sphere math, no solver wiring yet). Faithful ports of ACE
/// `Physics/Sphere.cs` / acclient `CSphere`, for the future collision resolver.

/// Parametric time of collision between a moving sphere (at origin, moving along
/// `movement`) and a static sphere at relative position `sphere_pos` with combined
/// radii `radsum`. Returns t in [0,1] on hit, or -1.0 (no hit / degenerate ray /
/// starting overlapped). Port of `Sphere.FindTimeOfCollision`
/// (Physics/Sphere.cs:232-249) / acclient.c:358481-358506.
pub fn find_time_of_collision(movement: Vector3, sphere_pos: Vector3, radsum: f32) -> f32 {
    // Solve |t*movement - sphere_pos| = radsum for the earliest t.
    //   a*t² - 2*B*t + C = 0,  a = movement·movement,
    //   B = sphere_pos·movement (>0 when the sphere is ahead),
    //   C = sphere_pos·sphere_pos - radsum².
    // Earliest root = (B - sqrt(B² - a*C)) / a. Returns -1.0 for a degenerate
    // ray, an already-overlapping start, or a miss.
    let a = movement.dot(&movement);
    if a < EPSILON {
        return -1.0;
    }
    let bb = sphere_pos.dot(&movement);
    let c = sphere_pos.dot(&sphere_pos) - radsum * radsum;
    if c < EPSILON {
        return -1.0;
    }
    let discriminant = bb * bb - a * c;
    if discriminant < 0.0 {
        return -1.0;
    }
    (bb - discriminant.sqrt()) / a
}

/// Static (at-rest) two-sphere overlap test: true if the spheres touch or overlap.
/// Port of `Sphere.CollidesWithSphere` (Physics/Sphere.cs:215-221) /
/// acclient.c:358509-358516.
pub fn collides_with_sphere(sphere_pos: Vector3, radsum: f32) -> bool {
    sphere_pos.length_squared() <= radsum * radsum
}

#[cfg(test)]
mod m1_sphere_tests {
    use super::*;

    #[test]
    fn find_time_of_collision_head_on_hit() {
        let t = find_time_of_collision(Vector3::new(1.0, 0.0, 0.0), Vector3::new(1.5, 0.0, 0.0), 0.5);
        assert!(t >= 0.0 && t <= 1.0, "expected hit in [0,1], got t={}", t);
    }
    #[test]
    fn find_time_of_collision_miss() {
        let t = find_time_of_collision(Vector3::new(1.0, 0.0, 0.0), Vector3::new(0.0, 2.0, 0.0), 0.5);
        assert!(t < 0.0, "expected miss (t=-1), got t={}", t);
    }
    #[test]
    fn find_time_of_collision_tangent() {
        let t = find_time_of_collision(Vector3::new(1.0, 0.0, 0.0), Vector3::new(1.0, 0.0, 0.5), 0.5);
        assert!(t >= 0.0 && t <= 1.0, "expected tangent hit in [0,1], got t={}", t);
    }
    #[test]
    fn find_time_of_collision_degenerate_ray() {
        let t = find_time_of_collision(Vector3::zero(), Vector3::new(0.5, 0.0, 0.0), 0.5);
        assert!(t < 0.0, "degenerate ray must return -1, got t={}", t);
    }
    #[test]
    fn find_time_of_collision_starts_overlapped() {
        let t = find_time_of_collision(Vector3::new(1.0, 0.0, 0.0), Vector3::new(0.1, 0.0, 0.0), 0.5);
        assert!(t < 0.0, "already overlapping must return -1, got t={}", t);
    }
    #[test]
    fn collides_with_sphere_overlap() {
        assert!(collides_with_sphere(Vector3::new(0.8, 0.0, 0.0), 1.0));
    }
    #[test]
    fn collides_with_sphere_miss() {
        assert!(!collides_with_sphere(Vector3::new(2.0, 0.0, 0.0), 1.0));
    }
    #[test]
    fn collides_with_sphere_tangent() {
        assert!(collides_with_sphere(Vector3::new(1.0, 0.0, 0.0), 1.0));
    }
    #[test]
    fn collides_with_sphere_concentric() {
        assert!(collides_with_sphere(Vector3::zero(), 0.5));
    }
}

/// Apply swept-sphere clamp + single-iteration slide. Returns the
/// new `delta` the integrator should consume (in place of the raw
/// `velocity * dt`). Does not mutate input.
pub fn clamp_delta_against_buildings(
    candidates: &[BuildingAabbEntry],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
) -> Vector3 {
    let (clamped, _) = clamp_delta_against_buildings_with_normal(candidates, pose, delta, radius);
    clamped
}

/// 2026-06-02 outdoor edge/cliff-slide (Phase 6 follow-on): apply
/// swept-sphere clamp + single-iteration slide and ALSO return the XY
/// contact-plane normal of the AABB face the sweep hit (pointing away
/// from the wall), or `None` when no wall blocked the move. Mirrors the
/// indoor per-poly clamp's `(delta, Option<normal>)` shape so the
/// integrator's edge_slide / cliff_slide stages can fire outdoors when
/// `USE_OUTDOOR_WALL_NORMALS` is enabled.
pub fn clamp_delta_against_buildings_with_normal(
    candidates: &[BuildingAabbEntry],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
) -> (Vector3, Option<Vector3>) {
    let Some(hit) = sweep_sphere_against_aabbs(candidates, pose, delta, radius) else {
        return (delta, None);
    };
    let backoff = 1e-3;
    let safe_t = (hit.t - backoff / delta.length().max(1e-6)).max(0.0);
    let stopped_delta = delta * safe_t;
    let remaining = delta * (1.0 - safe_t);
    let into_normal = remaining.dot(&hit.normal);
    let slide = remaining - hit.normal * into_normal;
    let wall_normal = hit.normal; // Surface the hit normal for edge/cliff-slide.
    if slide.length_squared() <= 1e-10 {
        return (stopped_delta, Some(wall_normal));
    }
    let slide_pose = WorldPosition {
        landblock_id: pose.landblock_id,
        coords: Vector3::new(
            pose.coords.x + stopped_delta.x,
            pose.coords.y + stopped_delta.y,
            pose.coords.z + stopped_delta.z,
        ),
        rotation: pose.rotation,
    };
    let slide_clamped = match sweep_sphere_against_aabbs(candidates, &slide_pose, slide, radius) {
        Some(slide_hit) => slide * (slide_hit.t - backoff / slide.length().max(1e-6)).max(0.0),
        None => slide,
    };
    (stopped_delta + slide_clamped, Some(wall_normal))
}

/// Phase 6 follow-on (academy rubberband, 2026-05-10): clamp a
/// proposed lateral delta so the player capsule centre stays inside
/// the cell's world-space AABB (inset by `radius` on X/Y).
///
/// Indoor rubberband mechanism: the integrator currently has no
/// indoor wall collision (the `building_aabb_index` is outdoor-only
/// — see `clamp_delta_against_buildings` above), so a few seconds of
/// forward walking inside a dungeon cell pushes the player past the
/// cell wall. ACE's server-side physics rejects the out-of-cell
/// pose, increments `force_position_sequence`, and rubber-bands the
/// player back to the last in-cell position. ACE log evidence: in
/// cell `0x860201AD` (Holtburg Outpost academy area) +Tester drifts
/// to `[-43.15, -95.47, 0.005]`, then ACE relocates to cell origin
/// `[12.32, -28.48, 0.005]`.
///
/// This is a coarser proxy than per-polygon collision against the
/// EnvCell's `physics_polygons` (which `holtburger-dat` already
/// parses but the wasm side does not yet surface) — clamping to the
/// cell's bounding box prevents the player from ever leaving the
/// cell, but doesn't model interior obstacles like pillars or steep
/// stair walls. A future commit can replace this with a swept-
/// triangle test against `physics_polygons` and demote this clamp
/// to a fast-reject early-out.
///
/// Mirrors `clamp_delta_against_buildings`'s public signature so the
/// integrator's call site reads as a sibling. `pose` is the player's
/// landblock-local pose (the integrator hasn't applied `delta` yet).
/// `cell` is the world-space AABB returned by `SpatialScene::cell_-
/// aabb(current_cell_id)`.
pub fn clamp_delta_to_cell_interior(
    pose: &WorldPosition,
    delta: Vector3,
    cell: &Aabb,
    radius: f32,
) -> Vector3 {
    if cell.is_empty() {
        return delta;
    }
    // Player's current global X/Y (per `WorldPosition::global_coords`).
    let global = pose.global_coords();
    let proposed_x = global.x + delta.x;
    let proposed_y = global.y + delta.y;
    // Inset the AABB by `radius` so the capsule centre never crosses
    // a wall by more than a hair. If the cell is narrower than 2*radius
    // on an axis (e.g. a tight corridor smaller than a player capsule
    // — degenerate but possible for boss arenas), collapse the bounds
    // to the centre rather than producing inverted bounds that would
    // jam the player at NaN.
    let inset_min_x = if cell.max.x - cell.min.x > 2.0 * radius {
        cell.min.x + radius
    } else {
        (cell.min.x + cell.max.x) * 0.5
    };
    let inset_max_x = if cell.max.x - cell.min.x > 2.0 * radius {
        cell.max.x - radius
    } else {
        (cell.min.x + cell.max.x) * 0.5
    };
    let inset_min_y = if cell.max.y - cell.min.y > 2.0 * radius {
        cell.min.y + radius
    } else {
        (cell.min.y + cell.max.y) * 0.5
    };
    let inset_max_y = if cell.max.y - cell.min.y > 2.0 * radius {
        cell.max.y - radius
    } else {
        (cell.min.y + cell.max.y) * 0.5
    };
    let clamped_global_x = proposed_x.clamp(inset_min_x, inset_max_x);
    let clamped_global_y = proposed_y.clamp(inset_min_y, inset_max_y);
    // Translate the clamped global X/Y back to a delta off the
    // pre-delta global pose. Z is untouched — the integrator's
    // indoor floor-Z snap (in `advance_local_pose_for_manual_drive`)
    // handles the vertical axis separately against the cell's min.z.
    Vector3::new(
        clamped_global_x - global.x,
        clamped_global_y - global.y,
        delta.z,
    )
}

use holtburger_common::Triangle;

/// Retail walkable-slope threshold: a contact plane counts as floor
/// (you can stand/walk on it) iff `Normal.Z >= FLOOR_Z`. This is the
/// ACE/retail `PhysicsGlobals.FloorZ` constant verbatim
/// (`external/ACE/Source/ACE.Server/Physics/PhysicsGlobals.cs:50`),
/// consumed by `PhysicsObj.set_on_walkable` (`PhysicsObj.cs:1232-1237`
/// — `Normal.Z < FloorZ ? set_on_walkable(false) : set_on_walkable(true)`).
/// `0.66417414618662751` corresponds to ~48.4° from horizontal —
/// anything steeper is treated as a wall, not a floor. Stored at full
/// f64 source precision and narrowed to `f32` for our normals.
///
/// Public so the cliff_slide caller can reproduce retail's
/// `CollisionInfo.ContactPlane.Normal.Z < zval` WALL test
/// (`Transition.EdgeSlide`, `Transition.cs:276`) on the surfaced
/// `cell_wall_normal` before invoking the seam-skid.
pub const FLOOR_Z: f32 = 0.664_174_15;

/// 2026-05-10 indoor collision (Phase 6 step G follow-on): return the
/// highest "floor" Z below `(x, y)` from the given triangles, or
/// `None` when no triangle qualifies. A triangle qualifies as a floor
/// when its plane normal points mostly upward (`normal.z >=
/// FLOOR_NORMAL_MIN`). We track the max Z amongst qualifying floors
/// whose `z_at_xy <= ceiling_z` so multi-floor cells (Z-stacked
/// EnvCells with stairs threading them) pick the floor below the
/// player's head, not one stacked on top.
///
/// Returns `None` for: no triangles loaded yet, or the player's
/// current XY is outside every floor triangle (e.g. drifted into a
/// gap between cells, or the cell's physics_polygons set is sparse).
/// The integrator's indoor branch falls back to `cell.aabb.min.z`
/// when this returns `None`, so the player still doesn't fall
/// through the world.
pub fn highest_floor_z_under(
    triangles: &[Triangle],
    x: f32,
    y: f32,
    ceiling_z: f32,
) -> Option<f32> {
    // Retail-parity walkable-slope cutoff: a triangle is floor iff its
    // normal points upward at least as much as `FLOOR_Z` (~48.4° from
    // horizontal). Raised from the legacy `0.5` (60°) to match ACE
    // `set_on_walkable` (`Normal.Z >= PhysicsGlobals.FloorZ`); steeper
    // inclines are walls. AC dungeon stairs are individual treads with
    // near-flat tops, so they remain well above this threshold.
    const FLOOR_NORMAL_MIN: f32 = FLOOR_Z;
    let mut best: Option<f32> = None;
    for tri in triangles {
        if !tri.contains_xy(x, y) {
            continue;
        }
        let Some(plane) = tri.plane() else {
            continue;
        };
        if plane.normal.z < FLOOR_NORMAL_MIN {
            continue;
        }
        let Some(z) = tri.z_at_xy(x, y) else {
            continue;
        };
        // Allow a small tolerance above the ceiling so a player
        // standing right on a floor (z == ceiling_z) doesn't lose
        // their footing because of f32 rounding.
        if z > ceiling_z + 1e-3 {
            continue;
        }
        match best {
            None => best = Some(z),
            Some(prev) if z > prev => best = Some(z),
            _ => {}
        }
    }
    best
}

/// Physics deep-dive 2026-06-01 (Dimension 3) — the unit plane normal of
/// the highest walkable floor below `(x, y)`, the contact-plane normal the
/// grounded friction step projects against (retail
/// `PhysicsObj.ContactPlane.Normal`, set by `set_current_pos`/`set_on_walkable`
/// from the walkable's `Plane`, `PhysicsObj.cs:1218,3480`).
///
/// Same floor-pick rule as [`highest_floor_z_under`] (max-Z qualifying floor
/// at or below `ceiling_z`, walkable iff `normal.z >= FLOOR_Z`), but returns
/// the chosen triangle's plane normal instead of its Z. `None` when no floor
/// triangle qualifies — the caller then falls back to a flat `(0,0,1)` normal
/// (a no-op projection), which is also the correct contact normal for the
/// outdoor heightmap path (locally flat per terrain sample).
pub fn floor_normal_under(
    triangles: &[Triangle],
    x: f32,
    y: f32,
    ceiling_z: f32,
) -> Option<Vector3> {
    const FLOOR_NORMAL_MIN: f32 = FLOOR_Z;
    let mut best: Option<(f32, Vector3)> = None;
    for tri in triangles {
        if !tri.contains_xy(x, y) {
            continue;
        }
        let Some(plane) = tri.plane() else {
            continue;
        };
        if plane.normal.z < FLOOR_NORMAL_MIN {
            continue;
        }
        let Some(z) = tri.z_at_xy(x, y) else {
            continue;
        };
        if z > ceiling_z + 1e-3 {
            continue;
        }
        match best {
            None => best = Some((z, plane.normal)),
            Some((prev_z, _)) if z > prev_z => best = Some((z, plane.normal)),
            _ => {}
        }
    }
    best.map(|(_, normal)| normal)
}

/// Physics deep-dive 2026-06-01 (gap 3) — step-UP decision.
///
/// When a grounded lateral move is *blocked* by a wall/riser, retail
/// tries to climb onto it instead of stopping dead, provided the
/// obstacle's walkable top is within `step_up_height` of the feet
/// (`Transition.StepUp`, `Transition.cs:746-777`, gated on
/// `OnWalkable` so the rise is capped at `ObjectInfo.StepUpHeight` —
/// `Transition.cs:761`). This is what gives retail curb-/stair-step.
///
/// This helper isolates the *threshold* decision so it is unit-testable
/// without the full integrator: the caller detects that the lateral was
/// blocked and probes the floor height at the *intended* (un-clamped)
/// destination, then asks here whether to climb.
///
/// Returns `Some(destination_floor_z)` (the feet Z to rise to) when the
/// move should step up; `None` when it should stay blocked. We climb
/// iff the destination floor is **above** the current feet (a riser,
/// not a descent — descents are handled by [`step_down_decision`]) by
/// at most `step_up_height`. A riser taller than `step_up_height` is a
/// real wall and stays blocked.
///
/// `blocked` is the caller's "the lateral clamp shortened the move
/// enough that we hit something" predicate; when `false` (clean lateral
/// move) we never step up. `destination_floor_z` is `None` when no
/// walkable floor exists at the intended destination (e.g. a gap), in
/// which case there is nothing to climb onto.
pub fn step_up_decision(
    blocked: bool,
    feet_z: f32,
    destination_floor_z: Option<f32>,
    step_up_height: f32,
) -> Option<f32> {
    if !blocked {
        return None;
    }
    let floor = destination_floor_z?;
    let rise = floor - feet_z;
    // Only climb a positive riser within step-up height. A small
    // EPSILON keeps a floor at (or a hair below) the feet from
    // registering as a climb — that's flat ground, not a step.
    if rise > EPSILON && rise <= step_up_height {
        Some(floor)
    } else {
        None
    }
}

/// Physics deep-dive 2026-06-01 (gap 3) — step-DOWN decision.
///
/// When a grounded player walks off a small drop, retail snaps the feet
/// down to follow the surface (within `step_down_height`) instead of
/// going ballistic; a drop *beyond* that is a real ledge and the player
/// falls (`Transition`'s `StepDown` path, capped at
/// `ObjectInfo.StepDownHeight` — `Transition.cs:855`).
///
/// Ours previously snapped any outdoor descent up to a fixed
/// `LEDGE_FALL_THRESHOLD_M = 0.5` heuristic and fell beyond it
/// (`holtburger-core .../system.rs`). This helper replaces that magic
/// number with the per-object `step_down_height` (1.5 m for the player
/// body, vs the 0.5 m heuristic) so curbs/short drops follow the
/// ground and only genuine ledges fall. The heuristic and the
/// step-down height are reconciled by passing the step-down height as
/// the threshold here.
///
/// `drop = feet_z - floor_z_below` (positive when the floor is below
/// the feet). Returns:
/// - [`StepDownOutcome::Snap`]`(floor_z_below)` when `0 <= drop <=
///   step_down_height` — snap the feet down to follow the surface.
/// - [`StepDownOutcome::Fall`] when `drop > step_down_height` — a real
///   ledge; let gravity take over.
/// - [`StepDownOutcome::Snap`]`(floor_z_below)` when `drop < 0` (the
///   floor is at or above the feet — flat ground or a tiny rise the
///   floor snap already handles); the caller's existing flat-ground
///   snap is preserved.
pub fn step_down_decision(feet_z: f32, floor_z_below: f32, step_down_height: f32) -> StepDownOutcome {
    let drop = feet_z - floor_z_below;
    if drop > step_down_height {
        StepDownOutcome::Fall
    } else {
        StepDownOutcome::Snap(floor_z_below)
    }
}

/// Result of [`step_down_decision`] / [`step_down_resolve`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StepDownOutcome {
    /// Snap the player's feet to this Z, following the surface.
    Snap(f32),
    /// The drop exceeds the step-down height — a real ledge; fall.
    Fall,
}

/// A7-R3 (2026-06-12, survey A7 §3 row 8): the airborne LANDING
/// walkable allowance — retail lands with `z_for_landing = 0.0871557`
/// (≈85° permit: refuse only near-vertical perching, allow landing on
/// faces far steeper than walkable; `acclient.c:40376`,
/// `:312807-312808`, `:312966-312967`;
/// `collision.rs physics_globals::LANDING_Z`). `None` (no normal
/// source) allows — absence of data never refuses a touchdown.
pub fn landing_allows_touchdown(floor_normal_z: Option<f32>, landing_allowance: f32) -> bool {
    floor_normal_z.is_none_or(|normal_z| normal_z >= landing_allowance)
}

/// A7-R2 (2026-06-12, survey A7 §3 rows 2/3): [`step_down_decision`]
/// plus retail's WALKABLE-landing acceptance — `Transition::StepDown`
/// succeeds only when `collision_info.contact_plane.N.z >= z_val`
/// (`acclient.c:312664-312669`; ACE `Transition.cs:855-870`), so a
/// descent onto a steeper-than-walkable face FALLS instead of snapping.
/// The ONE resolver both the outdoor (terrain) and indoor (per-poly)
/// step-down arms consume under `USE_WALKABLE_STEP_DOWN`
/// (movement/system.rs).
///
/// `floor_normal_z` is the destination surface normal's Z
/// (`terrain_normal_at` outdoors / `floor_normal_under` indoors);
/// `None` (no normal source) keeps the height-only decision — absence
/// of data never refuses a step. `allowance` is retail's `z_val`
/// walkable threshold ([`FLOOR_Z`] for normal movement;
/// `LANDING_Z` is the airborne-landing variant, A7-R3). The walkable
/// test gates DESCENTS only (`drop > 0`): the flat-ground/rise snap
/// folded into [`step_down_decision`] is the caller's pre-existing
/// floor snap, not retail's StepDown, and stays byte-identical.
/// `check_walkable`'s re-insert probe (`acclient.c:312475-312524`) is
/// survey row 3's remaining half — A6's transitional_insert seam.
pub fn step_down_resolve(
    feet_z: f32,
    floor_z_below: f32,
    floor_normal_z: Option<f32>,
    step_down_height: f32,
    allowance: f32,
) -> StepDownOutcome {
    match step_down_decision(feet_z, floor_z_below, step_down_height) {
        StepDownOutcome::Snap(z) => {
            let descending = feet_z - floor_z_below > 0.0;
            match floor_normal_z {
                Some(normal_z) if descending && normal_z < allowance => StepDownOutcome::Fall,
                _ => StepDownOutcome::Snap(z),
            }
        }
        StepDownOutcome::Fall => StepDownOutcome::Fall,
    }
}

/// 2026-05-10 indoor collision: clamp a proposed lateral delta
/// against indoor wall triangles. The player capsule is treated as a
/// vertical cylinder of `radius` centred at the pose, spanning Z ∈
/// `[pose.z, pose.z + height]`. For each triangle whose plane is
/// mostly vertical (`|normal.z| <= WALL_NORMAL_MAX`), we bisect the
/// proposed delta to find the earliest `t` where the cylinder's axis
/// (sampled at mid-height) gets within `radius` of the triangle.
/// Earliest hit clamps the delta + projects the remainder onto the
/// wall tangent for a single-iteration slide — same pattern as
/// `clamp_delta_against_buildings`.
///
/// This is a coarser proxy than a full swept-capsule-vs-triangle
/// test (it samples the capsule axis at one Z height rather than
/// integrating along the segment), but for AC dungeons — where
/// walls extend floor-to-ceiling and the player's mid-height is
/// representative — it gives accurate clamping for the cost of one
/// bisection per triangle. A future commit can upgrade to full
/// capsule-segment-vs-triangle if a wall-cap interaction surfaces
/// (e.g. a half-height railing).
///
/// Returns `delta` unchanged when no walls are present or no hits
/// occur. Defends against degenerate triangles (zero area) by
/// skipping any with `Plane::from_triangle == None`.
pub fn clamp_delta_against_cell_walls(
    triangles: &[Triangle],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
    height: f32,
) -> Vector3 {
    clamp_delta_against_cell_walls_with_exclusions(
        triangles, pose, delta, radius, height, &[],
    )
}

/// PR-RR 2026-05-23 (interim): same as `clamp_delta_against_cell_walls`,
/// but skips triangles whose centroid falls inside any of the supplied
/// `exclusion_aabbs`. Used to make an open door visually + physically
/// walk-through-able without per-part baking: when a door entity goes
/// ETHEREAL (open), the recv loop adds a small AABB centred on the
/// door's pose to `SpatialScene.open_door_exclusion_aabbs`. The
/// caller (`holtburger-core/src/client/movement/system.rs`) pulls the
/// list and passes it here, so cell-mesh triangles representing the
/// closed door panel (baked into the EnvCell BSP at landblock-load
/// time) are skipped while the door is open.
///
/// Proper fix (see `docs/FOLLOW_ONS.md` "Indoor door per-poly toggle"):
/// at cell-mesh bake time, tag each triangle with the door it belongs
/// to (spatial match against placed `Door`-flagged static objects in
/// the EnvCell) so this filter becomes O(1) per triangle instead of
/// O(n_open_doors). The centroid-in-AABB scan here is cheap enough
/// (~50 cell tris × ~5 open doors max per cell = 250 tests / frame
/// hot-path) for an interim, but doesn't generalise to giant-door /
/// portcullis / multi-panel cases where the AABB might enclose
/// non-door wall geometry too.
pub fn clamp_delta_against_cell_walls_with_exclusions(
    triangles: &[Triangle],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
    height: f32,
    exclusion_aabbs: &[Aabb],
) -> Vector3 {
    // Route through the substep dispatcher so this wrapper picks up the
    // CalcNumSteps loop when `USE_SUBSTEP_TRANSITION` is on; flag-OFF it
    // calls the single-pass `_with_normal` and is behaviour-identical.
    clamp_delta_against_cell_walls_dispatch(
        triangles,
        pose,
        delta,
        radius,
        height,
        exclusion_aabbs,
    )
    .0
}

/// Dispatch shared by the public cell-wall wrappers and the
/// `holtburger-core` integrator call site: routes to the CalcNumSteps
/// substep loop when [`USE_SUBSTEP_TRANSITION`] is on, else to the
/// single-pass [`clamp_delta_against_cell_walls_with_normal`]. Keeping
/// the flag check in ONE place means the three wrappers + the integrator
/// stay in lock-step on which solver they use, and the shipped behaviour
/// is provably unchanged while the flag is OFF (every consumer takes the
/// single-pass branch). Returns the same `(clamped, Option<normal>)`
/// shape as `_with_normal` so it drops in at the integrator site where
/// the wall normal feeds the edge_slide path.
#[inline]
pub fn clamp_delta_against_cell_walls_dispatch(
    triangles: &[Triangle],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
    height: f32,
    exclusion_aabbs: &[Aabb],
) -> (Vector3, Option<Vector3>) {
    if USE_SUBSTEP_TRANSITION {
        clamp_delta_against_cell_walls_substepped(
            triangles,
            pose,
            delta,
            radius,
            height,
            exclusion_aabbs,
        )
    } else {
        clamp_delta_against_cell_walls_with_normal(
            triangles,
            pose,
            delta,
            radius,
            height,
            exclusion_aabbs,
        )
    }
}

/// Physics deep-dive 2026-06-01 (gap 3 follow-up: edge_slide). Same
/// swept-circle wall clamp as
/// [`clamp_delta_against_cell_walls_with_exclusions`], but ALSO returns
/// the XY contact-plane normal of the earliest wall hit (pointing away
/// from the wall, back toward where the capsule came from), or `None`
/// when no wall blocked the move.
///
/// The two existing public wrappers above
/// ([`clamp_delta_against_cell_walls`] +
/// [`clamp_delta_against_cell_walls_with_exclusions`]) delegate here and
/// drop the normal, preserving their `Vector3`-only signatures. The
/// edge_slide path in
/// `crates/holtburger-core/src/client/movement/system.rs` consults the
/// returned normal so that when a step-up is *refused* (riser too tall),
/// the blocked residual can be slid along the wall tangent instead of
/// stopping dead — mirroring ACE's `SpherePath.StepUpSlide`
/// (`Physics/SpherePath.cs:309-317`) → `Sphere.SlideSphere`
/// (`Physics/Sphere.cs`), whose no-contact-plane branch projects the
/// residual onto the wall tangent (`offset = -N * dot(N, gDelta)`,
/// i.e. removes the into-wall component) exactly as the single-iteration
/// slide here already does.
///
/// The returned normal's `Z` is always zero (the lateral clamp never
/// moves Z); the full retail `cliff_slide` cross-product skid
/// (`N_new × N_last`) needs a SECOND contact plane tracked across
/// CTransition substeps, which our single-iteration solver does not
/// maintain — see the TODO at the system.rs edge_slide site.
pub fn clamp_delta_against_cell_walls_with_normal(
    triangles: &[Triangle],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
    height: f32,
    exclusion_aabbs: &[Aabb],
) -> (Vector3, Option<Vector3>) {
    // Aligned to `FLOOR_Z` so the wall classifier and the floor
    // classifier (`highest_floor_z_under`) partition the normal-Z axis
    // at exactly one retail boundary: a triangle whose `|normal.z|`
    // exceeds `FLOOR_Z` is floor (or ceiling) and is handled by the
    // floor raycast, so we skip it here; everything at or below
    // `FLOOR_Z` is a wall and gets laterally clamped. Previously this
    // sat at `0.7` while the floor cutoff was `0.5`, leaving a
    // `0.5..0.7` band that was simultaneously floor (for Z-snap) and
    // wall (laterally clamped). Raising `FLOOR_NORMAL_MIN` to `FLOOR_Z`
    // and matching the wall cutoff to the same value closes that seam:
    // no triangle is now both walkable floor and clamping wall.
    const WALL_NORMAL_MAX: f32 = FLOOR_Z;
    let lateral_len = (delta.x * delta.x + delta.y * delta.y).sqrt();
    if lateral_len < 1e-6 {
        return (delta, None);
    }

    let global = pose.global_coords();
    let mid_z = global.z + height * 0.5;
    let cap_z_min = global.z;
    let cap_z_max = global.z + height;

    let mut earliest_t = 1.0_f32;
    let mut earliest_normal: Option<Vector3> = None;

    for tri in triangles {
        let Some(plane) = tri.plane() else {
            continue;
        };
        if plane.normal.z.abs() > WALL_NORMAL_MAX {
            continue;
        }
        // Skip triangles whose Z range doesn't overlap our capsule.
        let tri_aabb = tri.aabb();
        if tri_aabb.max.z < cap_z_min || tri_aabb.min.z > cap_z_max {
            continue;
        }
        // PR-RR 2026-05-23: open-door exclusion. If the triangle's
        // centroid falls inside any active open-door AABB, skip it
        // — this is the interim fix for indoor doors whose collision
        // panel is part of the EnvCell BSP mesh.
        if !exclusion_aabbs.is_empty() {
            let cx = (tri.v0.x + tri.v1.x + tri.v2.x) * (1.0 / 3.0);
            let cy = (tri.v0.y + tri.v1.y + tri.v2.y) * (1.0 / 3.0);
            let cz = (tri.v0.z + tri.v1.z + tri.v2.z) * (1.0 / 3.0);
            let mut excluded = false;
            for ex in exclusion_aabbs {
                if cx >= ex.min.x && cx <= ex.max.x
                    && cy >= ex.min.y && cy <= ex.max.y
                    && cz >= ex.min.z && cz <= ex.max.z
                {
                    excluded = true;
                    break;
                }
            }
            if excluded {
                continue;
            }
        }

        // Signed distance from each end of the proposed motion to
        // the wall plane. Positive = on the +normal side.
        let start = Vector3::new(global.x, global.y, mid_z);
        let end = Vector3::new(global.x + delta.x, global.y + delta.y, mid_z);
        let dist_start = plane.distance_to_point(&start);
        let dist_end = plane.distance_to_point(&end);

        // Three cases:
        //   1. Already inside the radius shell at start → contact at t=0.
        //   2. Crosses the plane (signs differ) → contact when |dist|=radius.
        //   3. Same sign + both > radius → no penetration.
        let t_contact = if dist_start.abs() <= radius {
            // Case 1: already touching.
            0.0_f32
        } else if dist_start.signum() != dist_end.signum() {
            // Case 2: crossed. Solve for t where dist hits ±radius
            // on the start's side.
            let target = radius * dist_start.signum();
            // dist(t) = dist_start + (dist_end - dist_start) * t
            // → t = (target - dist_start) / (dist_end - dist_start)
            let denom = dist_end - dist_start;
            if denom.abs() < 1e-6 {
                continue;
            }
            let t = (target - dist_start) / denom;
            if !(0.0..=1.0).contains(&t) {
                continue;
            }
            t
        } else {
            // Case 3: same side, no crossing.
            continue;
        };

        // Sanity-check the contact point is within the triangle's
        // bounds — `closest_point` returns the on-triangle nearest
        // point; if it's > `radius` away then we passed an edge or
        // a corner of this triangle, which the swept-circle treats
        // as a non-hit (any neighbouring triangle will catch us if
        // the wall continues; otherwise the gap is real, e.g. a
        // doorway).
        let cap_at_t = Vector3::new(
            global.x + delta.x * t_contact,
            global.y + delta.y * t_contact,
            mid_z,
        );
        let cp = tri.closest_point(cap_at_t);
        let dx = cp.x - cap_at_t.x;
        let dy = cp.y - cap_at_t.y;
        let dz = cp.z - cap_at_t.z;
        let dist_3d = (dx * dx + dy * dy + dz * dz).sqrt();
        // Tolerance accounts for f32 rounding in the parametric
        // solve plus the capsule's mid-Z sample missing tall
        // triangles by a hair.
        if dist_3d > radius + 1e-2 {
            continue;
        }

        if t_contact < earliest_t {
            earliest_t = t_contact;
            // Slide normal: the wall's plane normal, projected to
            // XY (Z component zeroed since the integrator doesn't
            // change Z via the lateral clamp). Sign-flip so the
            // normal points AWAY from the wall toward where the
            // player came from — `dist_start.signum()` gives that.
            let nx = plane.normal.x * dist_start.signum();
            let ny = plane.normal.y * dist_start.signum();
            let n_len = (nx * nx + ny * ny).sqrt();
            let normal = if n_len < 1e-6 {
                // Plane is purely vertical (a rare edge case where
                // both lateral components round to zero) — fall
                // back to start-minus-closest-point.
                let mut fnx = cap_at_t.x - cp.x;
                let mut fny = cap_at_t.y - cp.y;
                let fn_len = (fnx * fnx + fny * fny).sqrt().max(1e-6);
                fnx /= fn_len;
                fny /= fn_len;
                Vector3::new(fnx, fny, 0.0)
            } else {
                Vector3::new(nx / n_len, ny / n_len, 0.0)
            };
            earliest_normal = Some(normal);
        }
    }

    let Some(normal) = earliest_normal else {
        return (delta, None);
    };
    if earliest_t >= 0.999 {
        // A hit was registered but so late in the sweep it's effectively
        // a graze — return the delta unchanged AND surface the normal so
        // the step-up-refused edge_slide path can still skid the residual
        // along this wall tangent if the move is otherwise blocked.
        return (delta, Some(normal));
    }

    // Backoff so the capsule sits a hair short of the wall (matches
    // the pattern in `clamp_delta_against_buildings`).
    let backoff = 1e-3;
    let safe_t = (earliest_t - backoff / lateral_len.max(1e-6)).max(0.0);
    let stopped = delta * safe_t;
    let remaining = delta * (1.0 - safe_t);
    let into_normal = remaining.dot(&normal);
    let slide = remaining - normal * into_normal;
    (stopped + slide, Some(normal))
}

/// Physics deep-dive 2026-06-01 (gap: CalcNumSteps substepping). Wrap
/// the single-iteration cell-wall clamp
/// ([`clamp_delta_against_cell_walls_with_normal`]) in a retail-faithful
/// substep loop so a fast lateral move is subdivided into
/// `ceil(dist/radius)` equal sub-segments that each collide + slide,
/// instead of one mid-point-sampled sweep that can tunnel a thin wall or
/// stop dead at the first wall of a concave (L-shaped) corner.
///
/// This is a faithful port of ACE's **non-viewer**
/// `Transition.CalcNumSteps` (`Physics/Transition.cs:97-140`, re-grep —
/// lines drift): for a non-viewer object retail computes
/// `step = dist / LocalSphere[0].Radius`; if `step > 1` then
/// `numSteps = ceil(step)` with `offsetPerStep = offset / numSteps` (an
/// EQUAL subdivision of the full delta), else if the offset is non-zero
/// `numSteps = 1`, else `numSteps = 0`. We compute the same on the
/// **lateral** length (the wall clamp is a 2D/XY swept circle; Z is
/// carried along each sub-segment but does not drive subdivision — the
/// retail viewer branch keys on the full `dist` instead, which we do NOT
/// use here, matching the non-viewer player path).
///
/// Loop semantics (mirrors retail's `step_sphere`/`collide_and_slide`
/// over `CTransition` substeps, but reusing OUR per-step collision — no
/// BSP rewrite):
/// - Clone `pose` into a mutable `working` pose.
/// - For each step, delegate the per-step CLAMPED-and-slid segment to
///   [`clamp_delta_against_cell_walls_with_normal`] from the working
///   pose with that step's slice of the delta (`offset_per_step`).
/// - Advance `working.coords` by the **clamped** segment (not the raw
///   `offset_per_step`), so the next step's sweep origin
///   (`working.global_coords()`, recomputed each step) reflects where we
///   actually ended up after the slide.
/// - Accumulate `total_clamped` (the sum of clamped segments — what the
///   caller applies) and carry `last_normal` across steps (the most
///   recent wall hit, for the edge_slide path + the deferred
///   `cliff_slide` hook below).
/// - Early-break when a step's clamped segment is ~zero-length (a fully
///   blocked sub-segment): the remaining steps would push the same
///   stuck origin into the same wall, so there is nothing more to gain
///   and we avoid burning the rest of the loop on a no-op.
///
/// Returns `(total_clamped, last_normal)` with the SAME shape +
/// semantics as [`clamp_delta_against_cell_walls_with_normal`] so it
/// drops in at every call site. With `num_steps <= 1` it is exactly one
/// delegated single-pass call ⇒ behaviour-identical to the shipped
/// solver (used for the A/B straight-wall parity test).
///
/// cliff_slide Stage-2 SHIPPED (retail `cliff_slide`,
/// `Transition.CliffSlide` `Physics/Transition.cs:242-266`): the
/// cross-product SEAM-skid `Vector3.Cross(contactPlane.Normal,
/// LastKnownContactPlane.Normal)` (Z-zeroed) is implemented in
/// [`cliff_slide_residual_along_seam`] and consumed by the integrator's
/// `edge_slide_refused_step_up` path behind the DEFAULT-OFF
/// `USE_CLIFF_SLIDE` flag. The integrator carries the
/// `LastKnownContactPlane` across integration slices via
/// `PlayerState::last_known_wall_normal` (the persistent analogue of the
/// per-substep `last_normal` accumulated below); this substep loop's
/// `last_normal` is the within-tick equivalent for callers that consume
/// the substepped result directly. Wiring the seam-skid INSIDE this
/// per-substep loop (so a single fast tick that crosses two walls skids
/// the seam mid-tick, not just across ticks) remains a localized
/// follow-up off this same accumulation point.
/// Retail non-viewer `Transition.CalcNumSteps` substep count, isolated
/// for unit testing (`Physics/Transition.cs:97-140`). Given the lateral
/// distance of the requested move and the swept-circle `radius`
/// (retail's `LocalSphere[0].Radius`):
/// - `dist <= EPSILON` ⇒ `0` (no motion to subdivide).
/// - `step = dist / radius`; if `step > 1.0` ⇒ `ceil(step)` (>= 2).
/// - otherwise ⇒ `1` (a single sub-segment for a non-zero short move).
///
/// Examples (radius 0.4, the player capsule): a 0.3 m move ⇒
/// `0.3/0.4 = 0.75 <= 1` ⇒ 1 step; a 1.0 m move ⇒ `1.0/0.4 = 2.5 > 1` ⇒
/// `ceil(2.5) = 3` steps.
pub fn cell_wall_substep_count(lateral_len: f32, radius: f32) -> usize {
    if lateral_len <= EPSILON {
        return 0;
    }
    let step = lateral_len / radius.max(1e-6);
    if step > 1.0 {
        // `step > 1.0` guarantees `ceil(step) >= 2`.
        step.ceil() as usize
    } else {
        1
    }
}

pub fn clamp_delta_against_cell_walls_substepped(
    triangles: &[Triangle],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
    height: f32,
    exclusion_aabbs: &[Aabb],
) -> (Vector3, Option<Vector3>) {
    // Retail non-viewer CalcNumSteps. When `USE_CALCNUMSTEPS_3D_DIST` is
    // `false` (DEFAULT), key the substep count on lateral (XY) distance only
    // (the wall sweep is a swept circle in XY, so Z does not subdivide).
    // When `true`, use the full 3D distance matching `Transition.CalcNumSteps`
    // (`offset.Length()`).
    let lateral_len = (delta.x * delta.x + delta.y * delta.y).sqrt();
    let dist_for_steps = if USE_CALCNUMSTEPS_3D_DIST {
        (delta.x * delta.x + delta.y * delta.y + delta.z * delta.z).sqrt()
    } else {
        lateral_len
    };

    // `dist <= EPS` ⇒ no motion to subdivide; nothing for the wall clamp to
    // do. Mirrors the `numSteps = 0` / `offset == Zero` arm of CalcNumSteps
    // (and the early-out the single-pass clamp already takes). Return the
    // delta untouched (Z passes through) with no normal.
    if dist_for_steps <= EPSILON {
        return (delta, None);
    }

    let num_steps = cell_wall_substep_count(dist_for_steps, radius);

    // `num_steps == 1` is the single-pass solver verbatim — keep it a
    // straight delegate (no loop overhead, provably behaviour-identical
    // to the shipped path; this is the A/B parity anchor).
    if num_steps <= 1 {
        return clamp_delta_against_cell_walls_with_normal(
            triangles,
            pose,
            delta,
            radius,
            height,
            exclusion_aabbs,
        );
    }

    let inv = 1.0 / num_steps as f32;
    let offset_per_step = delta * inv;

    let mut working = *pose;
    let mut total_clamped = Vector3::zero();
    let mut last_normal: Option<Vector3> = None;

    for _ in 0..num_steps {
        // Per-step collide + slide from the CURRENT working pose. The
        // sweep recomputes its global origin from `working.global_coords()`
        // internally, so advancing `working.coords` below is all that is
        // needed to march the origin forward between steps.
        let (clamped_step, step_normal) = clamp_delta_against_cell_walls_with_normal(
            triangles,
            &working,
            offset_per_step,
            radius,
            height,
            exclusion_aabbs,
        );

        total_clamped = total_clamped + clamped_step;
        // Carry the most-recent wall normal across steps. This is the
        // `LastKnownContactPlane` accumulation hook for the deferred
        // cliff_slide cross-product (see the TODO above): a later step
        // that hits a DIFFERENT wall has both planes available here.
        if step_normal.is_some() {
            last_normal = step_normal;
        }

        // Intra-substep cliff_slide (Stage-2 seam-skid), DEFAULT-OFF. When
        // enabled, if this step hit a wall (N_new) AND a previous step's wall
        // is known (N_last), replace the clamped residual with the seam-skid
        // (cross-product of the two normals) before advancing. Purely additive:
        // when off, `final_clamped == clamped_step` and the pose advances
        // identically to shipped behaviour.
        let mut final_clamped = clamped_step;
        if USE_CLIFF_SLIDE_INTRA_SUBSTEP
            && let (Some(n_new), Some(n_last)) = (step_normal, last_normal)
            && let Some(seam_skid) = cliff_slide_residual_along_seam(clamped_step, n_new, n_last)
        {
            final_clamped = seam_skid;
        }

        // Advance the working pose by the (possibly seam-skidded) segment so
        // the next step sweeps from where we actually ended up.
        working.coords = working.coords + final_clamped;

        // Early-break on a fully-blocked sub-segment: if this step's
        // lateral travel collapsed to ~0 (wall dead-ahead, no tangent to
        // slide along), the remaining steps would re-push the same stuck
        // origin into the same wall. Nothing more to accumulate.
        let step_lat = (clamped_step.x * clamped_step.x + clamped_step.y * clamped_step.y).sqrt();
        if step_lat <= EPSILON {
            break;
        }
    }

    (total_clamped, last_normal)
}

/// Physics deep-dive 2026-06-01 (gap 3 follow-up: edge_slide).
/// Project a (blocked) residual lateral delta onto the wall tangent so
/// it slides ALONG the wall instead of stopping dead against it: returns
/// `residual - normal * dot(residual, normal)` — the residual with its
/// into-wall (normal-direction) component removed.
///
/// This is the single-plane slide retail performs in
/// `Sphere.SlideSphere` (`Physics/Sphere.cs`) when there is no live
/// contact plane to cross with (`offset = -N * dot(N, gDelta)` removing
/// the into-wall component), which is the case
/// `SpherePath.StepUpSlide` (`Physics/SpherePath.cs:309-317`) hits after
/// it invalidates the contact plane on a refused step-up. The full
/// `cliff_slide` cross-product skid (`N_new × N_last`) needs a SECOND
/// tracked plane and is deferred — see the system.rs edge_slide TODO.
///
/// `normal` is expected to be the unit XY wall normal returned by
/// [`clamp_delta_against_cell_walls_with_normal`]. A degenerate
/// (near-zero) normal leaves the residual unchanged.
pub fn slide_residual_along_wall_tangent(residual: Vector3, normal: Vector3) -> Vector3 {
    let n_len_sq = normal.x * normal.x + normal.y * normal.y + normal.z * normal.z;
    if n_len_sq < 1e-12 {
        return residual;
    }
    let into_normal = residual.dot(&normal);
    residual - normal * into_normal
}

/// Physics deep-dive 2026-06-01 (cliff_slide Stage-2). Faithful port of
/// retail's `Transition.CliffSlide` (ACE
/// `external/ACE/Source/ACE.Server/Physics/Transition.cs:242-266`,
/// `acclient.c:312005`): the SEAM-skid that fires when a moving sphere is
/// wedged between TWO non-coplanar contact planes. Where the single-plane
/// [`slide_residual_along_wall_tangent`] removes the into-wall component
/// of a residual against ONE wall, this slides the residual along the
/// *line where two walls meet* — so a diagonal jammed into a concave
/// (L-shaped) corner rides the seam instead of stopping dead or popping
/// through.
///
/// Inputs:
/// - `residual`: the blocked residual move (retail's
///   `GlobalSphere.Center - GlobalCurrCenter.Center`, the offset the
///   sweep could not consume). We use the lateral residual the caller is
///   trying to redistribute.
/// - `n_new`: the CURRENT contact-plane normal (retail's
///   `contactPlane.Normal`, our `cell_wall_normal` for this slice).
/// - `n_last`: the PREVIOUSLY-tracked contact-plane normal (retail's
///   `CollisionInfo.LastKnownContactPlane.Normal`, our
///   `PlayerState::last_known_wall_normal`).
///
/// Math (1:1 with retail, re-grep `Transition.cs:244-265`):
/// ```text
/// cross  = n_new × n_last;  cross.z = 0          // seam DIRECTION (3D)
/// seam   = (-cross.y, cross.x, 0)                // perpendicular in XY
/// if NormalizeCheckSmall(seam) -> return None    // degenerate: planes
///                                                //   ~parallel, no seam
/// angle  = dot(seam, residual)
/// return Some(seam * (angle <= 0 ? angle : -angle))
/// ```
/// (Retail's `collideNormal = (contactNormal.Z - contactNormal.Y,
/// contactNormal.X - contactNormal.Z, 0)` reduces to `(-cross.y,
/// cross.x, 0)` because `contactNormal.Z` is zeroed on the prior line.)
///
/// Returns `None` whenever the caller should fall back to the Stage-1
/// single-plane slide: this happens when `NormalizeCheckSmall` reports
/// the seam degenerate — i.e. the two planes are near-parallel
/// (coplanar/anti-parallel normals ⇒ a near-zero cross product), so
/// there is no well-defined seam to ride. Mirrors retail returning
/// `TransitionState.OK` (no adjustment) from that branch, after which
/// `EdgeSlide` proceeds without a cliff adjustment.
///
/// `EPSILON` here is retail's `PhysicsGlobals.EPSILON = 0.0002`
/// (`PhysicsGlobals.cs:9`), the same threshold `NormalizeCheckSmall`
/// uses, so the degenerate bail fires at the identical magnitude.
pub fn cliff_slide_residual_along_seam(
    residual: Vector3,
    n_new: Vector3,
    n_last: Vector3,
) -> Option<Vector3> {
    // Retail PhysicsGlobals.EPSILON, the NormalizeCheckSmall threshold.
    const RETAIL_EPSILON: f32 = 0.0002;

    // Seam direction = N_new × N_last, projected into the XY plane.
    let mut cross = n_new.cross(&n_last);
    cross.z = 0.0;

    // Perpendicular-in-XY of the (Z-zeroed) cross product. With
    // cross.z == 0 this is retail's `collideNormal` after the
    // `contactNormal.Z - ...` terms drop their zero Z component.
    let mut seam = Vector3::new(-cross.y, cross.x, 0.0);

    // NormalizeCheckSmall: bail (no seam) when degenerate — the two
    // planes are near-parallel, so the cross product (hence the seam) is
    // ~zero-length and there is nothing meaningful to slide along.
    let len = seam.length();
    if len < RETAIL_EPSILON {
        return None;
    }
    seam = seam * (1.0 / len);

    // Project the residual onto the seam; retail flips the sign so the
    // adjustment always points back along (not past) the seam tangent.
    let angle = seam.dot(&residual);
    let signed = if angle <= 0.0 { angle } else { -angle };
    Some(seam * signed)
}

/// Workstream C (3D camera collision, 2026-05-11): result of a sweep
/// against an arbitrary collision primitive that doesn't carry a
/// `BuildingAabbEntry` reference. The follow-camera path needs to
/// reason about hits against statics + cell-mesh triangles (in
/// addition to buildings), and the consumer doesn't care which entry
/// produced the hit — only the contact point + normal so the camera
/// can place itself short of the obstacle and slide if needed.
///
/// `t` is the parametric time of first contact in `[0.0, 1.0]`,
/// `point` is the hit position in global world coords, `normal` is the
/// outward surface normal at the contact (pointing back toward the
/// sweep origin so the camera's pull-in math doesn't sign-flip).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GenericSweptHit {
    pub t: f32,
    pub point: Vector3,
    pub normal: Vector3,
}

/// Workstream C: sweep a sphere of `radius` along `delta` against a
/// list of statics-AABBs and return the earliest contact, mirroring
/// the building-AABB primitive but returning a `GenericSweptHit` so
/// the camera path can chain it with `sweep_sphere_against_triangles`.
///
/// The implementation is the same Minkowski-sum slab method as
/// `sweep_sphere_against_aabbs` — the only behavioural difference is
/// the return shape (no `BuildingAabbEntry` reference).
pub fn sweep_sphere_against_static_aabbs(
    candidates: &[crate::spatial::StaticAabbEntry],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
) -> Option<GenericSweptHit> {
    if delta.length_squared() <= 1e-10 || candidates.is_empty() {
        return None;
    }
    let start = pose.global_coords();
    let mut best: Option<(f32, Vector3)> = None;
    for entry in candidates {
        let inflated = entry.aabb.inflate(radius);
        if let Some((t, normal)) = ray_aabb_entry(start, delta, &inflated)
            && (best.is_none() || t < best.unwrap().0)
        {
            best = Some((t, normal));
        }
    }
    let (t, normal) = best?;
    let point = start + delta * t;
    Some(GenericSweptHit { t, point, normal })
}

/// Workstream C: sweep a sphere of `radius` from `start` to `end`
/// against a bag of world-space triangles and return the earliest
/// contact, or `None` for a clean miss.
///
/// Algorithm: per-triangle conservative AABB pre-cull, then a
/// parametric solve for the moving-sphere-vs-triangle test based on
/// the swept-sphere kernel in Real-Time Collision Detection §5.5.3
/// (Christer Ericson) — but simplified for the camera path:
///
///   1. Pre-reject: triangle AABB (inflated by radius) doesn't
///      intersect the sweep AABB → skip.
///   2. Compute the sphere-to-plane signed distance at `start` and
///      `end`. Both same sign + both > radius → no contact.
///   3. Otherwise solve for `t` where `signed_distance(t) = radius`
///      (sphere just touching the plane). Linear interp because
///      the centre moves linearly. Clamp to `[0, 1]`.
///   4. At `t`, project the sphere centre onto the triangle's plane
///      and clamp to the triangle interior via `Triangle::closest_point`.
///      If the projected-onto-triangle distance ≤ radius, this is a
///      valid hit; otherwise the sphere grazed past the triangle
///      (corner / edge case) — keep the `t` but use the closest-point
///      direction for the normal so the slide reads cleanly.
///
/// Returns the smallest-`t` hit across all triangles. Per-triangle
/// cost is dominated by the closest_point evaluation (the AABB pre-
/// cull rejects ~99% of indoor triangles for typical sweep lengths).
/// Tested in cargo with grazing + inside-out cases; live cost on a
/// Holtburg dungeon cell with ~120 triangles is well under 100 µs
/// per sweep (measured 2026-05-11 against Mite Maze).
pub fn sweep_sphere_against_triangles(
    triangles: &[Triangle],
    start: Vector3,
    end: Vector3,
    radius: f32,
) -> Option<GenericSweptHit> {
    if triangles.is_empty() {
        return None;
    }
    let delta = end - start;
    let delta_len = delta.length();
    if delta_len <= 1e-6 {
        // Degenerate sweep (zero motion): check for static-overlap
        // with any triangle and return t=0 if so.
        for tri in triangles {
            let cp = tri.closest_point(start);
            let dx = cp.x - start.x;
            let dy = cp.y - start.y;
            let dz = cp.z - start.z;
            if dx * dx + dy * dy + dz * dz <= radius * radius {
                let mut normal = Vector3::new(start.x - cp.x, start.y - cp.y, start.z - cp.z);
                let n_len = normal.length();
                if n_len > 1e-6 {
                    normal = Vector3::new(normal.x / n_len, normal.y / n_len, normal.z / n_len);
                } else if let Some(plane) = tri.plane() {
                    normal = plane.normal;
                } else {
                    continue;
                }
                return Some(GenericSweptHit {
                    t: 0.0,
                    point: cp,
                    normal,
                });
            }
        }
        return None;
    }

    // Sweep AABB (start-to-end inflated by radius) for pre-cull.
    let mut sweep_min = Vector3::new(
        start.x.min(end.x) - radius,
        start.y.min(end.y) - radius,
        start.z.min(end.z) - radius,
    );
    let mut sweep_max = Vector3::new(
        start.x.max(end.x) + radius,
        start.y.max(end.y) + radius,
        start.z.max(end.z) + radius,
    );
    // Defend against NaN (we read these every iter).
    if !sweep_min.x.is_finite() || !sweep_max.x.is_finite() {
        sweep_min = Vector3::new(f32::MIN, f32::MIN, f32::MIN);
        sweep_max = Vector3::new(f32::MAX, f32::MAX, f32::MAX);
    }

    let mut best_t = f32::INFINITY;
    let mut best_point = Vector3::zero();
    let mut best_normal = Vector3::new(0.0, 0.0, 1.0);

    for tri in triangles {
        let tri_aabb = tri.aabb();
        // Pre-cull: triangle AABB doesn't overlap sweep AABB → skip.
        if tri_aabb.max.x < sweep_min.x
            || tri_aabb.min.x > sweep_max.x
            || tri_aabb.max.y < sweep_min.y
            || tri_aabb.min.y > sweep_max.y
            || tri_aabb.max.z < sweep_min.z
            || tri_aabb.min.z > sweep_max.z
        {
            continue;
        }
        let Some(plane) = tri.plane() else { continue };
        let dist_start = plane.distance_to_point(&start);
        let dist_end = plane.distance_to_point(&end);
        // Both on same side, both farther than radius → no contact.
        if dist_start.abs() > radius && dist_end.abs() > radius && dist_start.signum() == dist_end.signum() {
            continue;
        }
        // Compute t for sphere-touches-plane: dist(t) = ±radius.
        // Pick the target sign matching dist_start so we hit the
        // *near* side first.
        let target = if dist_start.abs() <= radius {
            // Already inside the radius shell at t=0 — sphere starts
            // touching the plane. Use t=0.
            0.0_f32
        } else {
            let target_signed = radius * dist_start.signum();
            let denom = dist_end - dist_start;
            if denom.abs() < 1e-9 {
                continue;
            }
            let t = (target_signed - dist_start) / denom;
            if !(0.0..=1.0).contains(&t) {
                continue;
            }
            t
        };
        let centre_at_t = start + delta * target;
        // Project onto the triangle (clamped to interior).
        let cp = tri.closest_point(centre_at_t);
        let dx = cp.x - centre_at_t.x;
        let dy = cp.y - centre_at_t.y;
        let dz = cp.z - centre_at_t.z;
        let dist_sq = dx * dx + dy * dy + dz * dz;
        // Tolerance: parametric solve can land a hair outside the
        // triangle (grazing edge) — accept up to radius + ε so the
        // camera sweep doesn't miss a wall by f32 noise.
        if dist_sq > (radius + 1e-3) * (radius + 1e-3) {
            continue;
        }
        if target < best_t {
            best_t = target;
            best_point = cp;
            // Normal points from triangle surface back toward sweep
            // origin so the camera-pullback math reads consistently
            // with the building-sweep path. Derive from the start-
            // side of the plane.
            let plane_n = plane.normal;
            let signed = dist_start.signum();
            best_normal = Vector3::new(plane_n.x * signed, plane_n.y * signed, plane_n.z * signed);
        }
    }

    if best_t == f32::INFINITY {
        return None;
    }
    Some(GenericSweptHit {
        t: best_t,
        point: best_point,
        normal: best_normal,
    })
}

fn velocity_kinematics_for_input(input: &SolveBodyInput) -> (Vector3, Vector3) {
    match input.basis {
        Some(SolveProjectionBasis::Velocity { velocity, omega }) => (velocity, omega),
        Some(SolveProjectionBasis::GroundedMotion { .. }) | None => {
            (Vector3::zero(), Vector3::zero())
        }
    }
}

fn grounded_kinematics_for_input(input: &SolveBodyInput) -> Option<(Vector3, Vector3)> {
    match input.basis {
        Some(SolveProjectionBasis::GroundedMotion {
            desired_local_velocity,
            desired_local_omega,
        }) => Some((desired_local_velocity, desired_local_omega)),
        _ => None,
    }
}

pub(super) fn sample_mode_for_projection_state(
    projection_state: Option<SelfPlayerDriveProjectionState>,
    velocity: Vector3,
    omega: Vector3,
) -> SpatialSampleMode {
    match projection_state {
        Some(SelfPlayerDriveProjectionState::AuthorityFrozen) => SpatialSampleMode::Suspended,
        Some(SelfPlayerDriveProjectionState::LocalGroundedDirectDrive) => {
            SpatialSampleMode::SimulatingMotionState
        }
        Some(SelfPlayerDriveProjectionState::LocalAirborne)
        | Some(SelfPlayerDriveProjectionState::ServerControlled)
        | None => {
            if velocity.length_squared() > EPSILON || omega.length_squared() > EPSILON {
                SpatialSampleMode::SimulatingVelocity
            } else {
                SpatialSampleMode::SimulatingMotionState
            }
        }
    }
}

fn desired_heading_for_local_drive(control: &LocalDriveControl, current_heading: f32) -> f32 {
    if let Some(desired_heading) = control.desired_heading {
        return normalize_heading(desired_heading);
    }

    let planar_delta = Vector3::new(
        control.desired_world_delta.x,
        control.desired_world_delta.y,
        0.0,
    );
    if planar_delta.length_squared() <= EPSILON {
        current_heading
    } else {
        Vector3::zero().heading_to(&planar_delta)
    }
}

fn derive_self_player_projection_state(
    scene: &SpatialScene,
    control: &LocalDriveControl,
) -> SelfPlayerDriveProjectionState {
    let Some(body) = scene.body(control.body_id) else {
        return if control.force_grounded {
            SelfPlayerDriveProjectionState::LocalGroundedDirectDrive
        } else {
            SelfPlayerDriveProjectionState::LocalAirborne
        };
    };

    if body.sampling.mode == SpatialSampleMode::Suspended {
        return SelfPlayerDriveProjectionState::AuthorityFrozen;
    }

    if !control.force_grounded && body.contact == ContactState::Airborne {
        return SelfPlayerDriveProjectionState::LocalAirborne;
    }

    SelfPlayerDriveProjectionState::LocalGroundedDirectDrive
}

fn solve_self_player_local_drive(
    input: &SolveBodyInput,
    control: &LocalDriveControl,
    dt: Duration,
    scene: &SpatialScene,
) -> SolvedBodyKinematics {
    let projection_state = derive_self_player_projection_state(scene, control);
    let dt_secs = dt.as_secs_f32().max(0.0);
    let (velocity, omega) = velocity_kinematics_for_input(input);
    let current_contact = scene
        .body(control.body_id)
        .map(|body| body.contact)
        .unwrap_or(ContactState::Unknown);
    let resolved_contact = if input.contact == ContactState::Unknown {
        current_contact
    } else {
        input.contact
    };

    if dt_secs <= f32::EPSILON {
        return SolvedBodyKinematics {
            body_id: input.body_id,
            pose: input.pose,
            velocity,
            omega,
            contact: resolved_contact,
            projection_state: Some(projection_state),
        };
    }

    match projection_state {
        SelfPlayerDriveProjectionState::AuthorityFrozen => SolvedBodyKinematics {
            body_id: input.body_id,
            pose: input.pose,
            velocity: Vector3::zero(),
            omega: Vector3::zero(),
            contact: resolved_contact,
            projection_state: Some(projection_state),
        },
        SelfPlayerDriveProjectionState::LocalAirborne => {
            let mut solved = advance_body_kinematics(input, dt);
            solved.contact = resolved_contact;
            solved.projection_state = Some(projection_state);
            solved
        }
        SelfPlayerDriveProjectionState::LocalGroundedDirectDrive
        | SelfPlayerDriveProjectionState::ServerControlled => {
            let desired_velocity = control.desired_world_delta / dt_secs;
            let current_heading = input.pose.rotation.to_heading();
            let desired_heading = desired_heading_for_local_drive(control, current_heading);
            let candidates = scene.building_aabbs_near_pose(&input.pose);
            let mut next_pose = project_pose_by_velocity_with_collision(
                input.pose,
                desired_velocity,
                dt_secs,
                control.target_hint,
                &candidates,
            );
            next_pose.rotation = Quaternion::from_heading(desired_heading);

            SolvedBodyKinematics {
                body_id: input.body_id,
                pose: next_pose,
                velocity: desired_velocity,
                omega: Vector3::new(
                    0.0,
                    0.0,
                    signed_heading_delta(current_heading, desired_heading) / dt_secs,
                ),
                contact: if control.force_grounded {
                    ContactState::Grounded
                } else {
                    resolved_contact
                },
                projection_state: Some(projection_state),
            }
        }
    }
}

fn indoor_projection_landblock_id(
    authoritative_pose: WorldPosition,
    target_hint: Option<WorldPosition>,
) -> Option<Guid> {
    let indoor_hint_landblock_id = target_hint
        .filter(|hint| hint.is_indoors())
        .map(|hint| hint.landblock_id);

    indoor_hint_landblock_id.or_else(|| {
        authoritative_pose
            .is_indoors()
            .then_some(authoritative_pose.landblock_id)
    })
}

fn normalize_heading(heading: f32) -> f32 {
    heading.rem_euclid(TAU)
}

fn rotate_planar_velocity(velocity: Vector3, turn_step: f32) -> Vector3 {
    if turn_step.abs() <= f32::EPSILON {
        return velocity;
    }
    let sin = turn_step.sin();
    let cos = turn_step.cos();
    Vector3::new(
        (velocity.x * cos) + (velocity.y * sin),
        (-velocity.x * sin) + (velocity.y * cos),
        velocity.z,
    )
}

fn signed_heading_delta(current_heading: f32, desired_heading: f32) -> f32 {
    let mut delta = (desired_heading - current_heading) % TAU;
    if delta <= -PI {
        delta += TAU;
    } else if delta > PI {
        delta -= TAU;
    }
    delta
}

fn world_velocity_from_local_basis(local_velocity: Vector3, heading: f32) -> Vector3 {
    let forward = Vector3::new(-heading.cos(), heading.sin(), 0.0);
    let right = Vector3::new(heading.sin(), heading.cos(), 0.0);

    (forward * local_velocity.x)
        + (right * local_velocity.y)
        + Vector3::new(0.0, 0.0, local_velocity.z)
}

fn advance_grounded_body_kinematics(
    input: &SolveBodyInput,
    desired_local_velocity: Vector3,
    desired_local_omega: Vector3,
    dt: Duration,
) -> SolvedBodyKinematics {
    let dt_secs = dt.as_secs_f32().max(0.0);
    let current_heading = input.pose.rotation.to_heading();
    let world_velocity = world_velocity_from_local_basis(desired_local_velocity, current_heading);

    if dt_secs <= f32::EPSILON {
        return SolvedBodyKinematics {
            body_id: input.body_id,
            pose: input.pose,
            velocity: world_velocity,
            omega: desired_local_omega,
            contact: input.contact,
            projection_state: None,
        };
    }

    let next_heading = normalize_heading(current_heading + (desired_local_omega.z * dt_secs));
    let mut next_pose = project_pose_by_velocity(input.pose, world_velocity, dt_secs, None);
    next_pose.rotation = Quaternion::from_heading(next_heading);

    SolvedBodyKinematics {
        body_id: input.body_id,
        pose: next_pose,
        velocity: world_velocity,
        omega: desired_local_omega,
        contact: input.contact,
        projection_state: None,
    }
}

fn project_pose_by_offset(
    authoritative_pose: WorldPosition,
    offset: Vector3,
    target_hint: Option<WorldPosition>,
) -> WorldPosition {
    if offset.length_squared() <= f32::EPSILON {
        return authoritative_pose;
    }

    if let Some(indoor_landblock_id) =
        indoor_projection_landblock_id(authoritative_pose, target_hint)
    {
        let indoor_origin = WorldPosition {
            landblock_id: indoor_landblock_id,
            coords: Vector3::zero(),
            rotation: authoritative_pose.rotation,
        }
        .global_coords();
        let projected_global = authoritative_pose.global_coords() + offset;

        return WorldPosition {
            landblock_id: indoor_landblock_id,
            coords: Vector3::new(
                projected_global.x - indoor_origin.x,
                projected_global.y - indoor_origin.y,
                projected_global.z,
            ),
            rotation: authoritative_pose.rotation,
        };
    }

    let projected_global = authoritative_pose.global_coords() + offset;
    let landblock_x =
        (projected_global.x.div_euclid(METERS_PER_LANDBLOCK) as i32).clamp(0, 255) as u32;
    let landblock_y =
        (projected_global.y.div_euclid(METERS_PER_LANDBLOCK) as i32).clamp(0, 255) as u32;
    let low_word = authoritative_pose.landblock_id.0 & 0xFFFF;

    WorldPosition {
        landblock_id: Guid((landblock_x << 24) | (landblock_y << 16) | low_word),
        coords: Vector3::new(
            projected_global.x.rem_euclid(METERS_PER_LANDBLOCK),
            projected_global.y.rem_euclid(METERS_PER_LANDBLOCK),
            projected_global.z,
        ),
        rotation: authoritative_pose.rotation,
    }
    .normalize_outdoor_cell()
}

pub(crate) fn project_pose_by_velocity(
    authoritative_pose: WorldPosition,
    velocity: Vector3,
    dt_secs: f32,
    target_hint: Option<WorldPosition>,
) -> WorldPosition {
    if dt_secs <= 0.0 {
        return authoritative_pose;
    }

    project_pose_by_offset(authoritative_pose, velocity * dt_secs, target_hint)
}

/// Phase 6 step B: collision-aware variant of
/// [`project_pose_by_velocity`]. Sweeps the player capsule (treated
/// as a sphere at chest height) against `building_aabbs` before
/// applying the delta; clamps + slides on first contact. Falls back
/// to the unclamped path when `building_aabbs` is empty (preserves
/// pre-Phase-B behaviour during landblock entry / cache miss).
pub(crate) fn project_pose_by_velocity_with_collision(
    authoritative_pose: WorldPosition,
    velocity: Vector3,
    dt_secs: f32,
    target_hint: Option<WorldPosition>,
    building_aabbs: &[BuildingAabbEntry],
) -> WorldPosition {
    if dt_secs <= 0.0 {
        return authoritative_pose;
    }
    if building_aabbs.is_empty() {
        return project_pose_by_offset(authoritative_pose, velocity * dt_secs, target_hint);
    }
    let raw_delta = velocity * dt_secs;
    let clamped = clamp_delta_against_buildings(
        building_aabbs,
        &authoritative_pose,
        raw_delta,
        PLAYER_CAPSULE_RADIUS,
    );
    project_pose_by_offset(authoritative_pose, clamped, target_hint)
}

pub fn project_pose_forward_distance(
    authoritative_pose: WorldPosition,
    distance_m: f32,
) -> WorldPosition {
    if !distance_m.is_finite() {
        return authoritative_pose;
    }

    let heading = authoritative_pose.rotation.to_heading();
    let forward_offset = Vector3::new(-heading.cos(), heading.sin(), 0.0) * distance_m;

    project_pose_by_offset(authoritative_pose, forward_offset, None)
}

pub fn advance_body_kinematics(input: &SolveBodyInput, dt: Duration) -> SolvedBodyKinematics {
    let (velocity, omega) = velocity_kinematics_for_input(input);
    let dt_secs = dt.as_secs_f32().max(0.0);
    if dt_secs <= f32::EPSILON {
        return SolvedBodyKinematics {
            body_id: input.body_id,
            pose: input.pose,
            velocity,
            omega,
            contact: input.contact,
            projection_state: None,
        };
    }

    let turn_step = omega.z * dt_secs;
    let next_heading = normalize_heading(input.pose.rotation.to_heading() + turn_step);
    let next_velocity = rotate_planar_velocity(velocity, turn_step);

    let mut next_pose = input.pose;
    next_pose.rotation = Quaternion::from_heading(next_heading);
    next_pose.coords = next_pose.coords + (next_velocity * dt_secs);

    SolvedBodyKinematics {
        body_id: input.body_id,
        pose: next_pose,
        velocity: next_velocity,
        omega,
        contact: input.contact,
        projection_state: None,
    }
}

pub trait SpatialPhysics: Send + Sync + 'static {
    fn solve(&self, request: &SpatialSolveRequest, scene: &mut SpatialScene) -> SpatialSolveBatch;
}

#[derive(Debug, Default)]
pub struct BasicSpatialPhysics;

impl SpatialPhysics for BasicSpatialPhysics {
    fn solve(&self, request: &SpatialSolveRequest, scene: &mut SpatialScene) -> SpatialSolveBatch {
        let solved = request
            .bodies
            .iter()
            .map(|body| {
                if request
                    .local_drive
                    .as_ref()
                    .is_some_and(|control| control.body_id == body.body_id)
                    && let Some(control) = request.local_drive.as_ref()
                {
                    solve_self_player_local_drive(body, control, request.dt, scene)
                } else if let Some((desired_local_velocity, desired_local_omega)) =
                    grounded_kinematics_for_input(body)
                {
                    advance_grounded_body_kinematics(
                        body,
                        desired_local_velocity,
                        desired_local_omega,
                        request.dt,
                    )
                } else {
                    advance_body_kinematics(body, request.dt)
                }
            })
            .collect();

        SpatialSolveBatch {
            solved,
            events: Vec::new(),
        }
    }
}

#[derive(Debug, Default)]
pub struct NoopSpatialPhysics;

impl SpatialPhysics for NoopSpatialPhysics {
    fn solve(
        &self,
        _request: &SpatialSolveRequest,
        _scene: &mut SpatialScene,
    ) -> SpatialSolveBatch {
        SpatialSolveBatch {
            solved: Vec::new(),
            events: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::{Triangle, Vector3};

    /// Build a single ramp triangle inclined `degrees` from horizontal.
    /// The surface rises along +Y; its plane normal is `(0, -sin θ,
    /// cos θ)` (verified via `Plane::from_triangle`), so `normal.z =
    /// cos(θ)` — exactly the quantity ACE's `set_on_walkable` compares
    /// against `FloorZ`. The XY footprint spans well past the query
    /// point `(0.2, 0.1)` used by the tests below.
    fn ramp_triangle(degrees: f32) -> Triangle {
        let theta = degrees.to_radians();
        Triangle::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, theta.cos(), theta.sin()),
        )
    }

    /// Retail-parity (GAP 6, 2026-06-01): the walkable-slope cutoff is
    /// `FloorZ = 0.66417` (~48.4°), not the legacy `0.5` (60°). A 50°
    /// ramp has `normal.z = cos(50°) ≈ 0.643 < FloorZ`, so it is NOT a
    /// floor — `highest_floor_z_under` must reject it and return `None`.
    #[test]
    fn fifty_degree_ramp_is_not_walkable() {
        // Sanity: this ramp WAS accepted under the old 0.5 threshold
        // (cos(50°) ≈ 0.643 > 0.5) and must now be rejected.
        assert!(50.0_f32.to_radians().cos() > 0.5);
        assert!(50.0_f32.to_radians().cos() < FLOOR_Z);

        let tris = [ramp_triangle(50.0)];
        let floor = highest_floor_z_under(&tris, 0.2, 0.1, 100.0);
        assert_eq!(
            floor, None,
            "50° ramp (normal.z {:.4}) must be steeper than FloorZ {:.4} and not register as floor",
            50.0_f32.to_radians().cos(),
            FLOOR_Z,
        );
    }

    /// Retail-parity (GAP 6): a 45° ramp has `normal.z = cos(45°) ≈
    /// 0.707 >= FloorZ`, so it IS walkable and `highest_floor_z_under`
    /// must return the interpolated floor Z at the query point.
    #[test]
    fn forty_five_degree_ramp_is_walkable() {
        assert!(45.0_f32.to_radians().cos() >= FLOOR_Z);

        let tris = [ramp_triangle(45.0)];
        let floor = highest_floor_z_under(&tris, 0.2, 0.1, 100.0);
        assert!(
            floor.is_some(),
            "45° ramp (normal.z {:.4}) is shallower than FloorZ {:.4} and must register as floor",
            45.0_f32.to_radians().cos(),
            FLOOR_Z,
        );
        // Floor Z at (0.2, 0.1) on a 45° ramp rising in +Y: z = y = 0.1.
        let z = floor.unwrap();
        assert!(
            (z - 0.1).abs() < 1e-4,
            "expected floor Z ≈ 0.1 at (0.2, 0.1), got {z}",
        );
    }

    // ---- Physics deep-dive 2026-06-01 (Dimension 3): contact normal ----

    /// `floor_normal_under` returns a flat `(0,0,1)` normal for a
    /// horizontal floor triangle — the contact-plane normal the grounded
    /// friction step projects against on level ground (a no-op).
    #[test]
    fn floor_normal_under_flat_floor_is_up() {
        // A large flat floor at z = 5 spanning the query point.
        let tris = [Triangle::new(
            Vector3::new(-1.0, -1.0, 5.0),
            Vector3::new(2.0, -1.0, 5.0),
            Vector3::new(-1.0, 2.0, 5.0),
        )];
        let n = floor_normal_under(&tris, 0.2, 0.1, 100.0).expect("flat floor qualifies");
        assert!(n.x.abs() < 1e-6 && n.y.abs() < 1e-6, "flat normal: {n:?}");
        assert!((n.z.abs() - 1.0).abs() < 1e-6, "flat normal.z magnitude: {}", n.z);
    }

    /// `floor_normal_under` returns the tilted plane normal of a walkable
    /// ramp — the slope contact-plane normal the friction projection
    /// keys on. A 45° ramp rising in +Y has `normal = (0, ∓sin45,
    /// cos45)` (matching `Plane::from_triangle`'s winding), `|normal.z|
    /// ≈ 0.707`.
    #[test]
    fn floor_normal_under_ramp_is_tilted() {
        let tris = [ramp_triangle(45.0)];
        let n = floor_normal_under(&tris, 0.2, 0.1, 100.0).expect("45° ramp is walkable");
        let c = 45.0_f32.to_radians().cos();
        assert!((n.z - c).abs() < 1e-4, "ramp normal.z ≈ cos45: {}", n.z);
        assert!(n.y.abs() > 0.1, "ramp normal must tilt in Y: {n:?}");
    }

    /// `floor_normal_under` returns `None` when no walkable floor is
    /// under the query point (a too-steep ramp) — the caller then falls
    /// back to the flat `(0,0,1)` no-op normal.
    #[test]
    fn floor_normal_under_steep_ramp_is_none() {
        let tris = [ramp_triangle(50.0)]; // cos50 < FloorZ → wall
        assert_eq!(floor_normal_under(&tris, 0.2, 0.1, 100.0), None);
    }

    // ---- A7-R1 (2026-06-12): per-setup step heights ----

    /// The player's Setup `0x02000001` (`step_up = 0.6`,
    /// `step_down = 1.5`, `scale.z = 1.0`) resolves to EXACTLY the
    /// hardcoded player constants — the byte-identity contract that
    /// makes the per-setup read safe to thread through the player path.
    #[test]
    fn player_setup_step_heights_match_hardcoded_constants() {
        let (up, down) = setup_step_heights(Some(0.6), Some(1.5), 1.0);
        assert_eq!(up, PLAYER_STEP_UP_HEIGHT);
        assert_eq!(down, PLAYER_STEP_DOWN_HEIGHT);
    }

    /// Scaled setups scale their caps by `Scale.Z`
    /// (`acclient.c:325400-325424`; ACE `PartArray.cs:236-248`).
    #[test]
    fn scaled_setup_scales_step_heights() {
        let (up, down) = setup_step_heights(Some(0.6), Some(1.5), 2.0);
        assert_eq!(up, 1.2);
        assert_eq!(down, 3.0);
    }

    /// Setup-less movers fall back to `DefaultStepHeight = 0.01`,
    /// UNscaled (ACE `PartArray.cs:236-248` null-Setup arm).
    #[test]
    fn missing_setup_fields_fall_back_to_default_step_height() {
        let (up, down) = setup_step_heights(None, None, 2.0);
        assert_eq!(up, DEFAULT_STEP_HEIGHT);
        assert_eq!(down, DEFAULT_STEP_HEIGHT);
    }

    // ---- A7-R3 (2026-06-12): landing allowance ----

    /// `z_for_landing = 0.0871557` is deliberately laxer than `FLOOR_Z`:
    /// landing on steeper-than-walkable faces is allowed (they slide),
    /// only near-vertical perching refuses; `None` always allows.
    #[test]
    fn landing_allowance_refuses_only_near_vertical_faces() {
        use crate::spatial::collision::physics_globals::LANDING_Z;
        // Steeper than walkable (60°, N.z = 0.5) still LANDS.
        assert!(landing_allows_touchdown(Some(0.5), LANDING_Z));
        // Near-vertical (88°, N.z ≈ 0.035) refuses.
        assert!(!landing_allows_touchdown(Some(0.035), LANDING_Z));
        // Exactly at the allowance lands (>=).
        assert!(landing_allows_touchdown(Some(LANDING_Z), LANDING_Z));
        // No normal source: allow.
        assert!(landing_allows_touchdown(None, LANDING_Z));
    }

    // ---- A7-R2 (2026-06-12): walkable step-down ----

    /// A descent onto a steeper-than-walkable face (N.z < FLOOR_Z)
    /// FALLS instead of snapping (`acclient.c:312664-312669`).
    #[test]
    fn step_down_onto_steep_face_falls() {
        let feet_z = 10.0;
        let floor = 9.0; // 1 m drop, within the 1.5 cap
        // 60° face: N.z = 0.5 < FLOOR_Z (0.664...).
        assert_eq!(
            step_down_resolve(feet_z, floor, Some(0.5), PLAYER_STEP_DOWN_HEIGHT, FLOOR_Z),
            StepDownOutcome::Fall
        );
        // Walkable face: snaps exactly as the height-only decision.
        assert_eq!(
            step_down_resolve(feet_z, floor, Some(0.9), PLAYER_STEP_DOWN_HEIGHT, FLOOR_Z),
            StepDownOutcome::Snap(floor)
        );
    }

    /// No normal source → height-only decision (absence of data never
    /// refuses); flat-ground/rise snap is never walkable-gated; a
    /// too-deep drop still falls regardless of the normal.
    #[test]
    fn step_down_resolve_degrades_to_height_only_decision() {
        assert_eq!(
            step_down_resolve(10.0, 9.0, None, PLAYER_STEP_DOWN_HEIGHT, FLOOR_Z),
            StepDownOutcome::Snap(9.0)
        );
        // Rise/flat (drop <= 0): the caller's floor snap, not StepDown —
        // steep normal does NOT gate it.
        assert_eq!(
            step_down_resolve(10.0, 10.2, Some(0.5), PLAYER_STEP_DOWN_HEIGHT, FLOOR_Z),
            StepDownOutcome::Snap(10.2)
        );
        assert_eq!(
            step_down_resolve(10.0, 8.0, Some(0.9), PLAYER_STEP_DOWN_HEIGHT, FLOOR_Z),
            StepDownOutcome::Fall
        );
    }

    // ---- Physics deep-dive 2026-06-01 (gap 3): step-up / step-down ----

    /// A riser no taller than `PLAYER_STEP_UP_HEIGHT` is climbable: when
    /// the lateral move is blocked and a walkable floor sits within the
    /// step-up height at the destination, `step_up_decision` returns the
    /// floor Z to rise onto. Mirrors retail `Transition.StepUp` capped
    /// at `ObjectInfo.StepUpHeight` (`Transition.cs:761`).
    #[test]
    fn riser_within_step_up_height_is_climbable() {
        // Feet at z=10, a 0.3 m riser (well under the 0.6 m player
        // step-up). Blocked by the riser wall.
        let feet_z = 10.0_f32;
        let riser_top = feet_z + 0.3;
        let decision = step_up_decision(true, feet_z, Some(riser_top), PLAYER_STEP_UP_HEIGHT);
        assert_eq!(
            decision,
            Some(riser_top),
            "a {:.2} m riser is within the {:.2} m step-up and must be climbable",
            riser_top - feet_z,
            PLAYER_STEP_UP_HEIGHT,
        );
    }

    /// A riser taller than `PLAYER_STEP_UP_HEIGHT` stays blocked:
    /// `step_up_decision` returns `None` so the lateral clamp holds and
    /// the player is stopped by the wall (no climbing onto a real wall).
    #[test]
    fn riser_above_step_up_height_still_blocks() {
        let feet_z = 10.0_f32;
        // 1.0 m riser — above the 0.6 m player step-up.
        let riser_top = feet_z + 1.0;
        assert!(riser_top - feet_z > PLAYER_STEP_UP_HEIGHT);
        let decision = step_up_decision(true, feet_z, Some(riser_top), PLAYER_STEP_UP_HEIGHT);
        assert_eq!(
            decision, None,
            "a {:.2} m riser exceeds the {:.2} m step-up and must stay blocked",
            riser_top - feet_z,
            PLAYER_STEP_UP_HEIGHT,
        );
    }

    /// A clean (un-blocked) lateral move never steps up, and a floor at
    /// or below the feet is a descent (handled by step-down), not a
    /// climb — both yield `None`.
    #[test]
    fn step_up_no_op_when_not_blocked_or_not_a_riser() {
        let feet_z = 10.0_f32;
        // Not blocked: clean move, even with a reachable riser ahead.
        assert_eq!(
            step_up_decision(false, feet_z, Some(feet_z + 0.3), PLAYER_STEP_UP_HEIGHT),
            None,
            "an un-blocked move must never step up",
        );
        // Blocked, but the floor is a drop, not a riser → step-down's job.
        assert_eq!(
            step_up_decision(true, feet_z, Some(feet_z - 0.3), PLAYER_STEP_UP_HEIGHT),
            None,
            "a descent must not register as a step-up",
        );
        // Blocked, but no walkable floor at the destination (a gap).
        assert_eq!(
            step_up_decision(true, feet_z, None, PLAYER_STEP_UP_HEIGHT),
            None,
            "no floor at the destination → nothing to climb onto",
        );
    }

    /// A drop no deeper than `PLAYER_STEP_DOWN_HEIGHT` snaps the feet
    /// down to follow the surface (curb / short step), rather than
    /// going ballistic. Mirrors retail `Transition` step-down capped at
    /// `ObjectInfo.StepDownHeight` (`Transition.cs:855`).
    #[test]
    fn drop_within_step_down_height_snaps_down() {
        let feet_z = 10.0_f32;
        // 1.0 m drop — under the 1.5 m player step-down.
        let floor_below = feet_z - 1.0;
        assert!(feet_z - floor_below <= PLAYER_STEP_DOWN_HEIGHT);
        let outcome = step_down_decision(feet_z, floor_below, PLAYER_STEP_DOWN_HEIGHT);
        assert_eq!(
            outcome,
            StepDownOutcome::Snap(floor_below),
            "a {:.2} m drop is within the {:.2} m step-down and must snap to the surface",
            feet_z - floor_below,
            PLAYER_STEP_DOWN_HEIGHT,
        );
    }

    /// A drop deeper than `PLAYER_STEP_DOWN_HEIGHT` is a real ledge:
    /// `step_down_decision` returns `Fall` so the gravity integrator
    /// takes over and the player drops with a proper arc.
    #[test]
    fn drop_beyond_step_down_height_falls() {
        let feet_z = 10.0_f32;
        // 2.0 m drop — beyond the 1.5 m player step-down (a ledge).
        let floor_below = feet_z - 2.0;
        assert!(feet_z - floor_below > PLAYER_STEP_DOWN_HEIGHT);
        let outcome = step_down_decision(feet_z, floor_below, PLAYER_STEP_DOWN_HEIGHT);
        assert_eq!(
            outcome,
            StepDownOutcome::Fall,
            "a {:.2} m drop exceeds the {:.2} m step-down and must fall",
            feet_z - floor_below,
            PLAYER_STEP_DOWN_HEIGHT,
        );
    }

    // ---- edge_slide (gap 3 follow-up, 2026-06-01) ----
    // `WorldPosition`, `Guid`, `Quaternion` are in scope via `super::*`.

    /// A floor-to-ceiling wall whose plane is +X-facing: it occupies the
    /// plane `x = wall_x` and spans a tall Z range + wide Y footprint so
    /// a capsule sweeping in +X gets clamped. Plane normal is `±X`
    /// (`normal.z = 0 <= FLOOR_Z`), so it classifies as a wall.
    fn x_facing_wall(wall_x: f32) -> Triangle {
        // Two-point spread in Y and Z; winding gives a normal in the XY
        // plane (X component dominant).
        Triangle::new(
            Vector3::new(wall_x, -2.0, -1.0),
            Vector3::new(wall_x, 2.0, -1.0),
            Vector3::new(wall_x, -2.0, 3.0),
        )
    }

    fn wall_test_pose(x: f32, y: f32) -> WorldPosition {
        // Landblock 0x0000 so `global_coords()` == local coords — the
        // wall triangles below are authored in the same near-origin
        // frame the sweep compares against.
        WorldPosition {
            landblock_id: Guid(0x0000_0000),
            coords: Vector3::new(x, y, 0.0),
            rotation: Quaternion::from_heading(0.0),
        }
    }

    /// `slide_residual_along_wall_tangent` removes the into-wall
    /// component: a residual heading straight into an +X-facing wall
    /// (normal `(-1,0,0)`) is fully cancelled in X but any Y component is
    /// preserved. Mirrors the no-contact-plane branch of retail
    /// `Sphere.SlideSphere` (`offset = -N * dot(N, residual)`).
    #[test]
    fn slide_residual_drops_into_wall_component() {
        // Wall normal points back toward the player along -X.
        let normal = Vector3::new(-1.0, 0.0, 0.0);
        // Residual pushes into the wall (+X) and along it (+Y).
        let residual = Vector3::new(0.4, 0.3, 0.0);
        let slid = slide_residual_along_wall_tangent(residual, normal);
        assert!(slid.x.abs() < 1e-6, "into-wall X must be removed, got {}", slid.x);
        assert!((slid.y - 0.3).abs() < 1e-6, "tangent Y must be preserved, got {}", slid.y);
    }

    /// A degenerate (zero) normal leaves the residual untouched — the
    /// caller has no wall tangent to slide along.
    #[test]
    fn slide_residual_zero_normal_is_identity() {
        let residual = Vector3::new(0.4, 0.3, 0.0);
        let slid = slide_residual_along_wall_tangent(residual, Vector3::zero());
        assert!((slid.x - 0.4).abs() < 1e-6 && (slid.y - 0.3).abs() < 1e-6);
    }

    /// A residual already parallel to the wall (no into-wall component)
    /// passes through unchanged.
    #[test]
    fn slide_residual_parallel_is_unchanged() {
        let normal = Vector3::new(-1.0, 0.0, 0.0);
        let residual = Vector3::new(0.0, 0.5, 0.0); // pure +Y, along the wall
        let slid = slide_residual_along_wall_tangent(residual, normal);
        assert!(slid.x.abs() < 1e-6 && (slid.y - 0.5).abs() < 1e-6);
    }

    /// `clamp_delta_against_cell_walls_with_normal` surfaces the XY wall
    /// normal of the blocking wall: a capsule pushing +X into an
    /// +X-facing wall is clamped AND the returned normal points back
    /// toward the player (`-X`, `normal.z == 0`).
    #[test]
    fn clamp_with_normal_surfaces_wall_normal() {
        let tris = [x_facing_wall(0.5)];
        // Player just short of the wall, moving +X into it.
        let pose = wall_test_pose(0.0, 0.0);
        let delta = Vector3::new(1.0, 0.0, 0.0);
        let (clamped, normal) = clamp_delta_against_cell_walls_with_normal(
            &tris,
            &pose,
            delta,
            PLAYER_CAPSULE_RADIUS,
            PLAYER_CAPSULE_HEIGHT,
            &[],
        );
        // Move was shortened (blocked by the wall).
        assert!(
            clamped.x < delta.x - 1e-3,
            "expected the +X move to be clamped short of the wall, got {clamped:?}"
        );
        let normal = normal.expect("a blocking wall must surface a normal");
        assert!(normal.z.abs() < 1e-6, "wall normal Z must be flattened, got {}", normal.z);
        assert!(
            normal.x < 0.0,
            "wall normal must point back toward the player (-X), got {normal:?}"
        );
        // Unit length in XY.
        let len = (normal.x * normal.x + normal.y * normal.y).sqrt();
        assert!((len - 1.0).abs() < 1e-4, "wall normal must be unit length, got {len}");
    }

    /// No wall in range → `clamp_delta_against_cell_walls_with_normal`
    /// returns the delta unchanged and a `None` normal.
    #[test]
    fn clamp_with_normal_no_wall_returns_none() {
        let tris: [Triangle; 0] = [];
        let pose = wall_test_pose(0.0, 0.0);
        let delta = Vector3::new(1.0, 0.0, 0.0);
        let (clamped, normal) = clamp_delta_against_cell_walls_with_normal(
            &tris,
            &pose,
            delta,
            PLAYER_CAPSULE_RADIUS,
            PLAYER_CAPSULE_HEIGHT,
            &[],
        );
        assert_eq!(clamped, delta);
        assert!(normal.is_none());
    }

    // ---- cliff_slide Stage-2 (cross-product seam-skid, 2026-06-01) ----

    /// Two PERPENDICULAR walls meeting in a concave corner, each tilted
    /// back (normals carry a +Z component — the inside of a pyramid
    /// corner / two ramp faces). `N_new` is the +X-facing wall
    /// `(-1,0,0.5)`-normalized; `N_last` the +Y-facing wall
    /// `(0,-1,0.5)`-normalized. The retail cross product
    /// `N_new × N_last` (Z-zeroed) yields a seam running along the
    /// corner; its XY direction is the 45-degree diagonal. A residual
    /// pushing diagonally into the corner is redistributed along that
    /// 45-degree seam instead of stopping at the first wall.
    ///
    /// (Two AXIS-vertical perpendicular walls are a documented retail
    /// degenerate — see `cliff_slide_axis_vertical_perp_walls_bail` —
    /// because their cross is purely vertical and the Z-zero kills it.)
    #[test]
    fn cliff_slide_perpendicular_walls_ride_45_deg_seam() {
        let n_new = Vector3::new(-1.0, 0.0, 0.5).normalize();
        let n_last = Vector3::new(0.0, -1.0, 0.5).normalize();
        let residual = Vector3::new(0.3, 0.4, 0.0);
        let out = cliff_slide_residual_along_seam(residual, n_new, n_last)
            .expect("a non-degenerate corner seam must yield a skid");

        // Reconstruct the seam direction exactly as the helper does.
        let mut cross = n_new.cross(&n_last);
        cross.z = 0.0;
        let seam = Vector3::new(-cross.y, cross.x, 0.0).normalize();
        // The seam is the 45-degree diagonal (|x| == |y|).
        assert!(
            (seam.x.abs() - seam.y.abs()).abs() < 1e-5,
            "perpendicular tilted walls must give a 45-deg seam, got {seam:?}"
        );
        // The skid rides that seam (collinear in XY, non-zero length).
        let collinear_z = seam.x * out.y - seam.y * out.x;
        assert!(
            collinear_z.abs() < 1e-5,
            "skid must be collinear with the 45-deg seam, got skid {out:?} seam {seam:?}"
        );
        assert!(
            out.length() > 1e-4,
            "a diagonal residual into the corner must produce a non-zero seam skid, got {out:?}"
        );
    }

    /// Two AXIS-vertical perpendicular walls (`(-1,0,0)` and `(0,-1,0)`):
    /// the cross product is purely ±Z, so the retail `contactNormal.Z=0`
    /// step zeroes it to a degenerate vector and `NormalizeCheckSmall`
    /// bails ⇒ `None`. The caller then falls back to the Stage-1
    /// single-plane slide. Documents the exact retail edge case.
    #[test]
    fn cliff_slide_axis_vertical_perp_walls_bail() {
        let n_new = Vector3::new(-1.0, 0.0, 0.0);
        let n_last = Vector3::new(0.0, -1.0, 0.0);
        let residual = Vector3::new(0.3, 0.3, 0.0);
        assert!(
            cliff_slide_residual_along_seam(residual, n_new, n_last).is_none(),
            "axis-vertical perpendicular walls cross to a pure-Z (degenerate) seam ⇒ None"
        );
    }

    /// Degenerate case: near-PARALLEL walls (almost-coplanar normals).
    /// `N_new == N_last` (identical planes) ⇒ `cross = 0` ⇒ seam is
    /// degenerate ⇒ `None` (caller falls back to the Stage-1
    /// single-plane slide). Mirrors retail `NormalizeCheckSmall`
    /// returning `true` and `CliffSlide` returning `OK` (no adjustment).
    #[test]
    fn cliff_slide_parallel_walls_returns_none() {
        let n = Vector3::new(-1.0, 0.0, 0.0);
        let residual = Vector3::new(0.3, 0.2, 0.0);
        // Identical normals.
        assert!(cliff_slide_residual_along_seam(residual, n, n).is_none());
        // Anti-parallel normals (the same plane, opposite winding) —
        // cross is still ~zero ⇒ None.
        let anti = Vector3::new(1.0, 0.0, 0.0);
        assert!(cliff_slide_residual_along_seam(residual, n, anti).is_none());
        // A tiny perturbation off-parallel: still below the seam EPSILON
        // ⇒ None. `(-1,0,0)` vs `(-1, 1e-5, 0)` normalized.
        let nearly = Vector3::new(-1.0, 1e-5, 0.0).normalize();
        assert!(
            cliff_slide_residual_along_seam(residual, n, nearly).is_none(),
            "near-parallel vertical walls cross to a sub-EPSILON pure-Z seam ⇒ None"
        );
    }

    /// The skid is signed so it always points back along (never past)
    /// the seam: for a positive `angle = dot(seam, residual)` the helper
    /// returns `seam * -angle`, for a non-positive angle `seam * angle`.
    /// Either way the result projected onto the seam is `<= 0`.
    #[test]
    fn cliff_slide_skid_is_non_advancing_along_seam() {
        let n_new = Vector3::new(-1.0, 0.0, 0.5).normalize();
        let n_last = Vector3::new(0.0, -1.0, 0.5).normalize();
        let mut cross = n_new.cross(&n_last);
        cross.z = 0.0;
        let seam = Vector3::new(-cross.y, cross.x, 0.0).normalize();

        // residual with a +seam component.
        let residual_pos = seam * 0.5;
        let out_pos = cliff_slide_residual_along_seam(residual_pos, n_new, n_last).unwrap();
        assert!(
            seam.dot(&out_pos) <= 1e-6,
            "positive-angle skid must not advance along the seam, got proj {}",
            seam.dot(&out_pos)
        );

        // residual with a -seam component.
        let residual_neg = seam * -0.5;
        let out_neg = cliff_slide_residual_along_seam(residual_neg, n_new, n_last).unwrap();
        assert!(
            seam.dot(&out_neg) <= 1e-6,
            "negative-angle skid stays non-advancing, got proj {}",
            seam.dot(&out_neg)
        );
    }
}
