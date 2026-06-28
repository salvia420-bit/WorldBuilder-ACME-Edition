//! Phase 3 B4 (2026-06-28) — `SpatialScene` → `CObjCell` bridge for the
//! decomp-faithful `CTransition` collision driver (holtburger-dat
//! `transition::driver_validate`).
//!
//! This module is the seam that lets the faithful driver
//! ([`holtburger_dat::transition::CTransition::find_valid_position`]) run
//! against the live client's loaded geometry. It supplies:
//!   * [`SceneObjCell`] — the per-cell `CObjCell` adapter. Its `find_collisions`
//!     caches the swept sphere into the cell's local frame
//!     (`SPHEREPATH::cache_localspace_sphere`) and runs the Phase-2
//!     env-cell resolver (`resolver_find::find_collisions`) over the cell's
//!     physics BSP. Static / object collisions are identity (Phase C).
//!   * [`SceneWorld`] — the `CellWorld` seam (`GetVisible` /
//!     `add_all_outside_cells` / `get_block_offset`) over a borrowed
//!     [`SpatialScene`].
//!   * [`FaithfulMover`] — the `MovingObjectPhysics` gravity query.
//!   * [`faithful_find_transitional_position`] — the marshalling entry that
//!     builds a `CTransition`, runs `find_valid_position`, and maps the result
//!     back to a [`TransitionOutcome`].
//!
//! ## Phase A scope (this change)
//! COMPILES + WIRED, behind the default-OFF `USE_FAITHFUL_TRANSITION` flag.
//! Flag-OFF the live path is byte-identical (the dispatcher routes to the
//! unchanged [`super::transition::find_transitional_position`]). Flag-ON the
//! local player's INDOOR (env-cell) collision routes through the faithful
//! driver; OUTDOOR poses delegate to the existing heightfield pipeline; statics
//! are identity.
//!
//! ## Phase B scope (this change — `mod drift` A/B drift harness)
//! The drift harness A/B's [`faithful_find_transitional_position`] vs the
//! approximate [`super::transition::find_transitional_position`] over synthetic
//! INDOOR scenes (flat floor / wall / ledge populated in BOTH representations).
//! It SETTLED the marshalling SHAPE laptop-side: the WorldPosition↔Position
//! round-trip (single-LB indoor), `cell_changed` (single-cell), the binary
//! `state`, and the grounded SIGNAL (`ON_WALKABLE`, not the transient
//! `walkable` latch). It also surfaced the live gate: the resolver's
//! `CTransition::step_up` is a PHASE3 stub, so a CONTACT mover's
//! `step_sphere_up` falls through to a slide and stamps NO contact plane — the
//! faithful path does not yet hard-stop at walls or latch floor-grounded. That
//! EMPIRICAL behaviour (grounded / wall_normal firing, portal-spanning,
//! outdoor) rides the in-world `?faithfulTransition=on` 1070 A/B and is tagged
//! `// VERIFY(1070):`.
//!
//! ## Frame convention (Phase A)
//! The driver runs in WORLD space: player + cell `Position` frames carry
//! `global_coords()` origins and identity (player) / quaternion-basis (cell)
//! orientation. The resolver's `cache_localspace_sphere` then reduces to
//! `cell.orientation⁻¹·(world − cell.origin)` — geometrically IDENTICAL to the
//! existing [`super::scene::SpatialScene::cell_physics_bsp_solid`]'s
//! `world_to_local`, so the indoor cell-local collision matches the live BSP
//! solver. `LandDefs::get_block_offset` is `0` within one landblock (the only
//! case Phase A exercises).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Quaternion, Sphere, Vector3};

use holtburger_dat::transition::driver_validate::MovingObjectPhysics;
use holtburger_dat::transition::frame_transform::Frame;
use holtburger_dat::transition::objcell::{
    CObjCell, CellArrayApi, CellWorld, LandblockRef, PhysicsObjRef, WaterType,
};
use holtburger_dat::transition::types::{
    object_info_state, CTransition, LandDefs, ObjCellHandle, Position, SpherePath,
};

use super::collision::TransitionState;
use super::scene::{CellPhysicsBsp, SpatialScene};
use super::transition::{
    find_transitional_position, TransitionEnv, TransitionInput, TransitionOutcome,
};

/// `METERS_PER_LANDBLOCK` (8 cells × 24 units). Local re-spell to avoid leaking
/// the `holtburger_common::position` const through the bridge surface.
const METERS_PER_LANDBLOCK: f32 = 192.0;

/// Build a [`Frame`] whose `m_fl2gv` is the column-major local→global basis of
/// `orientation` (`column i = orientation·e_i`) and whose origin is `origin`.
/// The transpose (`globaltolocalvec`) is the orthonormal inverse, so
/// `Frame::globaltolocal` reproduces `orientation⁻¹·(p − origin)` — exactly the
/// scene's `world_to_local`.
fn frame_from(orientation: Quaternion, origin: Vector3) -> Frame {
    let cx = orientation.rotate_vector(Vector3::new(1.0, 0.0, 0.0));
    let cy = orientation.rotate_vector(Vector3::new(0.0, 1.0, 0.0));
    let cz = orientation.rotate_vector(Vector3::new(0.0, 0.0, 1.0));
    Frame {
        fl2gv: [cx.x, cx.y, cx.z, cy.x, cy.y, cy.z, cz.x, cz.y, cz.z],
        origin,
    }
}

// ─── SceneObjCell — the per-cell CObjCell adapter ───────────────────────────

/// One loaded EnvCell as the faithful driver's `CObjCell`. Owns a CLONE of the
/// cell's physics BSP (the `Rc<dyn CObjCell>` handle the driver wants is
/// `'static`, so the cell cannot borrow the scene). The clone is bounded to
/// once per distinct cell per transition by [`SceneWorld`]'s cache.
pub struct SceneObjCell {
    /// `this->m_DID.id` — the full 32-bit cell id.
    cell_id: u32,
    /// `this->pos` — the cell frame (WORLD origin + orientation basis). Identity
    /// when the cell has no physics BSP (the find_collisions identity branch).
    pos: Position,
    /// The cell's physics BSP (cell-local tree + resolved polys + frame), cloned
    /// out of [`SpatialScene::cell_physics_bsp`]. `None` ⇒ no narrow-phase
    /// geometry → `find_collisions` is identity (statics / outdoor are handled
    /// elsewhere).
    bsp: Option<CellPhysicsBsp>,
    /// Phase C: the cell's resident STATIC objects' physics BSPs (each framed to
    /// WORLD via its own origin/orientation), cloned out of
    /// [`SpatialScene::cell_static_physics_bsp`]. The faithful analogue of the
    /// decomp's `CEnvCell` shadow-object list — iterated by [`Self::find_obj_collisions`]
    /// after the env-cell geometry, so static walls/doors/props stop the mover
    /// instead of being walked through.
    statics: Vec<CellPhysicsBsp>,
    /// The cell's WORLD-space AABB (from [`SpatialScene::cell_aabb`]). Drives
    /// [`Self::point_in_cell`] so `find_cell_list` re-seats `check_cell` to this
    /// cell each step instead of nulling it (the base trait `point_in_cell`
    /// returns false, which would disable collision after the first step).
    /// VERIFY(1070): the decomp's `CEnvCell::point_in_cell` (acclient.c:347935)
    /// uses the precise cell-membership BSP (`CellStruct.cell_bsp`, carried in
    /// [`super::scene::CellMembership`]); the AABB is a looser client-side bound
    /// — adequate for the single-cell indoor sweep, refine for cross-portal.
    aabb: Option<Aabb>,
    /// `((CEnvCell*)this)->stab_list` — the portal-visible neighbour cell ids
    /// (the cell ring `find_transit_cells` floods).
    portal_neighbours: Vec<u32>,
}

impl CObjCell for SceneObjCell {
    fn id(&self) -> u32 {
        self.cell_id
    }

    fn pos(&self) -> &Position {
        &self.pos
    }

    fn water_type(&self) -> WaterType {
        // Phase A: water is handled by the existing pipeline's water gates.
        // VERIFY(1070): wire EnvCell water_type through the cell adapter (live
        // EnvCell data; the drift harness has no water fixtures).
        WaterType::NotWater
    }

    fn cur_landblock(&self) -> Option<Rc<dyn LandblockRef>> {
        None
    }

    fn restriction_obj(&self) -> u32 {
        0
    }

    fn objects(&self) -> &[Rc<dyn PhysicsObjRef>] {
        &[]
    }

    fn shadow_objects(&self) -> &[Rc<dyn PhysicsObjRef>] {
        &[]
    }

    fn visible_cells(&self) -> Vec<u32> {
        self.portal_neighbours.clone()
    }

    /// `CEnvCell::point_in_cell` (acclient.c:347935) — does `point` (WORLD space
    /// for same-landblock queries: `find_cell_list` passes
    /// `global_sphere[0].center − block_offset`) lie inside this cell? Used by
    /// `find_cell_list` to re-seat `check_cell` each step. Without this the base
    /// returns false and `check_other_cells` nulls `check_cell`, silently
    /// disabling collision after step 0. Uses the cell AABB (see the `aabb`
    /// field's VERIFY note on the precise membership-BSP form).
    fn point_in_cell(&self, point: Vector3) -> bool {
        match self.aabb {
            Some(a) => {
                point.x >= a.min.x
                    && point.x <= a.max.x
                    && point.y >= a.min.y
                    && point.y <= a.max.y
                    && point.z >= a.min.z
                    && point.z <= a.max.z
            }
            None => false,
        }
    }

    /// `CEnvCell::find_transit_cells` (acclient.c:348250) — flood the portal
    /// neighbour cell ids into the ring. Phase A appends them with NULL handles:
    /// the PRIMARY (player's own) cell is collision-tested faithfully via
    /// `world.get_visible(check_cell)`; cross-portal collision (resolving the
    /// neighbour handles) needs the scene reference a `'static` cell cannot
    /// hold — VERIFY(1070): a shared resolver for portal-spanning sweeps (the
    /// drift harness is single-cell; cross-portal needs the live cell graph).
    fn find_transit_cells(
        &self,
        _p: &Position,
        _num_sphere: u32,
        _spheres: &[Sphere],
        cell_array: &mut dyn CellArrayApi,
        _path: Option<&mut SpherePath>,
    ) {
        for &nb in &self.portal_neighbours {
            cell_array.add_cell(nb, None);
        }
    }

    /// `CEnvCell::find_collisions` (acclient.c:347816) — env collisions FIRST,
    /// then object/static collisions, and only when the env pass returned OK
    /// (decomp 347816-347818). A cell with no env BSP still runs its statics
    /// (an unbaked-environment cell can carry resident static objects).
    fn find_collisions(&self, transition: &mut CTransition) -> i32 {
        let scale = if transition.object_info.scale != 0.0 {
            transition.object_info.scale
        } else {
            1.0
        };
        if let Some(bsp) = self.bsp.as_ref() {
            // SPHEREPATH::cache_localspace_sphere(&this->pos, scale) — the
            // resolver's localspace_* input — then BSPTREE::find_collisions over
            // the cell-local environment tree.
            transition
                .sphere_path
                .cache_localspace_sphere(&self.pos, scale);
            let env = holtburger_dat::transition::resolver_find::find_collisions(
                &bsp.tree,
                transition,
                scale,
                &bsp.polys,
            );
            if env != TransitionState::OK as i32 {
                return env;
            }
        }
        // Object/static collisions (Phase C).
        self.find_obj_collisions(transition)
    }

    /// `CObjCell::find_obj_collisions` (acclient.c:347142) — sweep the mover
    /// against each resident static object's physics BSP. The decomp instantiates
    /// stabs as `CPhysicsObj` shadow objects and runs `CPhysicsObj::FindObjCollisions`
    /// per object, **breaking on the first non-OK result** (acclient.c:347151-347169);
    /// object collisions are skipped entirely for an INITIAL placement insert
    /// (`insert_type != 2`). Each static here is a `CellPhysicsBsp` framed to world
    /// via its own origin/orientation, so we cache the swept sphere into the
    /// static's frame (`cache_localspace_sphere`) and run the same Phase-2 resolver
    /// the env pass uses (`CGfxObj::find_obj_collisions` → `BSPTREE::find_collisions`).
    fn find_obj_collisions(&self, transition: &mut CTransition) -> i32 {
        // acclient.c:347151 — `if ( insert_type != 2 )`: statics are not tested
        // during the initial placement probe.
        if transition.sphere_path.insert_type
            == holtburger_dat::transition::types::InsertType::InitialPlacement
        {
            return TransitionState::OK as i32;
        }
        let scale = if transition.object_info.scale != 0.0 {
            transition.object_info.scale
        } else {
            1.0
        };
        for st in &self.statics {
            // The static's WORLD frame (origin + orientation basis) — the part
            // pose `CPhysicsPart::find_obj_collisions` caches into (acclient.c:314669).
            let st_pos = Position {
                objcell_id: self.cell_id,
                frame: frame_from(st.orientation, st.origin),
            };
            transition
                .sphere_path
                .cache_localspace_sphere(&st_pos, scale);
            let r = holtburger_dat::transition::resolver_find::find_collisions(
                &st.tree,
                transition,
                scale,
                &st.polys,
            );
            // acclient.c:347162 — first object whose result != OK wins.
            if r != TransitionState::OK as i32 {
                return r;
            }
        }
        TransitionState::OK as i32
    }
}

// ─── SceneWorld — the CellWorld seam over a borrowed SpatialScene ────────────

/// `CellWorld` adapter over a borrowed [`SpatialScene`]. Caches the built
/// `Rc<dyn CObjCell>` handles so each distinct cell's BSP is cloned at most once
/// per transition.
pub struct SceneWorld<'a> {
    scene: &'a SpatialScene,
    cache: RefCell<HashMap<u32, Option<Rc<dyn CObjCell>>>>,
}

impl<'a> SceneWorld<'a> {
    pub fn new(scene: &'a SpatialScene) -> Self {
        Self {
            scene,
            cache: RefCell::new(HashMap::new()),
        }
    }

    /// Build the `CObjCell` handle for `cell_id`, or `None` when the cell is not
    /// resident (no physics BSP and not in the portal graph). The handle owns a
    /// CLONE of the cell's physics BSP (`'static` requirement).
    fn build_cell(&self, cell_id: u32) -> Option<Rc<dyn CObjCell>> {
        let bsp = self.scene.cell_physics_bsp(cell_id).cloned();
        let statics = self.scene.cell_static_physics_bsp(cell_id).to_vec();
        let aabb = self.scene.cell_aabb(cell_id);
        let portal_neighbours = self.scene.cell_portal_neighbours(cell_id).to_vec();
        if bsp.is_none() && statics.is_empty() && portal_neighbours.is_empty() {
            // Not resident → the decomp's GetVisible returns null.
            return None;
        }
        let pos = match &bsp {
            Some(b) => Position {
                objcell_id: cell_id,
                frame: frame_from(b.orientation, b.origin),
            },
            None => Position {
                objcell_id: cell_id,
                frame: Frame::identity(),
            },
        };
        let cell = SceneObjCell {
            cell_id,
            pos,
            bsp,
            statics,
            aabb,
            portal_neighbours,
        };
        Some(Rc::new(cell) as Rc<dyn CObjCell>)
    }
}

impl CellWorld for SceneWorld<'_> {
    fn get_visible(&self, cell_id: u32) -> Option<ObjCellHandle> {
        if let Some(cached) = self.cache.borrow().get(&cell_id) {
            return cached.clone();
        }
        let built = self.build_cell(cell_id);
        self.cache.borrow_mut().insert(cell_id, built.clone());
        built
    }

    /// `CLandCell::add_all_outside_cells` — the outdoor terrain ring. Phase A is
    /// INDOOR-faithful and delegates OUTDOOR poses to the existing heightfield
    /// pipeline, so `find_cell_list` never takes the outdoor branch on the
    /// faithful path (an indoor root cell's low u16 is ≥ 0x100). No-op here.
    /// VERIFY(1070) (Phase D): wire `add_all_outside_cells_sphere` + a scene `Landscape`
    /// / `LandDefsSeam` when the faithful path covers outdoor sweeps.
    fn add_all_outside_cells(
        &self,
        _p: &Position,
        _num_sphere: u32,
        _spheres: &[Sphere],
        _cell_array: &mut dyn CellArrayApi,
    ) {
    }

    fn block_offset(&self, base_cell: u32, other_cell: u32) -> Vector3 {
        LandDefs::get_block_offset(base_cell, other_cell)
    }
}

// ─── FaithfulMover — the MovingObjectPhysics gravity query ───────────────────

/// `object_info.object->state & GRAVITY_PS` (acclient.c:312274). The local
/// player is gravity-affected.
pub struct FaithfulMover {
    has_gravity: bool,
}

impl MovingObjectPhysics for FaithfulMover {
    fn has_gravity(&self) -> bool {
        self.has_gravity
    }
}

// ─── Marshalling entry ───────────────────────────────────────────────────────

/// Phase-3 faithful transition entry — build a `CTransition`, run the decomp
/// driver, and marshal the result back into a [`TransitionOutcome`].
///
/// Phase A routing: OUTDOOR poses delegate to the existing heightfield pipeline
/// ([`find_transitional_position`]); an INDOOR pose whose cell has no physics
/// BSP also delegates (the academy-rubberband pre-bake guard). Otherwise the
/// local player's env-cell collision routes through the faithful driver.
pub fn faithful_find_transitional_position(
    env: &dyn TransitionEnv,
    input: &TransitionInput,
) -> TransitionOutcome {
    // OUTDOOR → existing heightfield pipeline (statics identity within it).
    if !input.begin.is_indoors() {
        return find_transitional_position(env, input);
    }

    let scene = env.scene();
    let begin_cell = scene.current_cell(&input.begin);
    let end_cell = scene.current_cell(&input.end);

    // No physics BSP for the begin cell → nothing for the faithful env path to
    // test. Fall back to the existing pipeline (pre-bake guard parity).
    if scene.cell_physics_bsp(begin_cell).is_none() {
        return find_transitional_position(env, input);
    }

    // WORLD-space frames (identity player rotation → vertical two-sphere
    // capsule, matching `cell_physics_bsp_solid`). VERIFY(1070): a non-vertical
    // mover orientation would need the player rotation basis here (the player
    // capsule is upright; the drift harness exercises the identity-frame case).
    let mut begin_frame = Frame::identity();
    begin_frame.origin = input.begin.global_coords();
    let begin_pos = Position {
        objcell_id: begin_cell,
        frame: begin_frame,
    };
    let mut end_frame = Frame::identity();
    end_frame.origin = input.end.global_coords();
    let end_pos = Position {
        objcell_id: end_cell,
        frame: end_frame,
    };

    // Two-sphere capsule (ACE NumSphere == 2): low at feet+radius, high at
    // head−radius, both of `radius`. Centers are object-local (Z-only), so the
    // identity frame places them vertically at the world feet position.
    let radius = input.object.radius;
    let height = input.object.height;
    let spheres = [
        Sphere {
            center: Vector3::new(0.0, 0.0, radius),
            radius,
        },
        Sphere {
            center: Vector3::new(0.0, 0.0, (height - radius).max(radius)),
            radius,
        },
    ];

    let mut t = CTransition::new();
    t.object_info.scale = 1.0;
    t.object_info.state = input.object.state; // bit layout matches dat's
    t.object_info.step_up_height = input.object.step_up_height;
    t.object_info.step_down_height = input.object.step_down_height;
    t.object_info.ethereal = input.object.ethereal;
    t.init_sphere(2, &spheres, 1.0);
    t.init_path(Some(begin_cell), Some(&begin_pos), &end_pos);

    let world = SceneWorld::new(scene);
    // The player is gravity-affected (GRAVITY_PS). VERIFY(1070): thread the
    // real per-object gravity bit if non-player movers route here (only the
    // local player routes here today — always gravity-affected).
    let mover = FaithfulMover { has_gravity: true };
    let found = t.find_valid_position(&world, &mover);

    // ── Marshal CTransition → TransitionOutcome ──
    // curr_pos.frame.origin is the settled feet position in WORLD space; convert
    // back to landblock-local coords. Phase B (drift harness `mod drift`,
    // faithful_bridge.rs) validated the single-landblock indoor rebucket: the
    // driver's settled `curr_pos.frame.origin` round-trips exactly through
    // `begin`'s landblock origin (indoor dungeons are single-landblock, so
    // `curr.objcell_id` keeps `begin`'s high word). VERIFY(1070): a cross-
    // landblock indoor seam (real portal handles) needs the live cell graph —
    // see `find_transit_cells` / `add_all_outside_cells` (Phase C/D).
    let curr = t.sphere_path.curr_pos;
    let (lb_x, lb_y) = input.begin.landblock_coords();
    let lb_origin_x = lb_x as f32 * METERS_PER_LANDBLOCK;
    let lb_origin_y = lb_y as f32 * METERS_PER_LANDBLOCK;
    let pose = WorldPosition {
        landblock_id: input.begin.landblock_id,
        coords: Vector3::new(
            curr.frame.origin.x - lb_origin_x,
            curr.frame.origin.y - lb_origin_y,
            curr.frame.origin.z,
        ),
        rotation: input.end.rotation,
    };

    // grounded ← the retail post-transition grounded state: OBJECTINFO's
    // `ON_WALKABLE` bit, which `validate_transition` recomputes each step from
    // the settled contact plane (`is_valid_walkable(contact_plane.normal)`,
    // acclient.c:312330-312350) — the persistent grounded latch. The transient
    // `SPHEREPATH::walkable` poly (set only inside the resolver's walk branches)
    // is OR'd as a belt-and-braces second source. Phase B (drift harness)
    // settled the MAPPING SHAPE: `walkable.is_some()` alone is a transient
    // scratch, not the grounded state — `ON_WALKABLE` is the faithful signal.
    // VERIFY(1070): the EMPIRICAL firing of either source is gated on the
    // resolver's `CTransition::step_up` / `find_walkable` PHASE3 port (a CONTACT
    // mover's `step_sphere_up` currently falls through to a slide and establishes
    // no contact plane, so neither source latches on flat ground yet — Phase C).
    let grounded = (t.object_info.state & object_info_state::ON_WALKABLE) != 0
        || t.sphere_path.walkable.is_some();
    // wall_normal ← COLLISIONINFO::last_known_contact_plane normal (Plane and
    // Vector3 are the shared holtburger_common types — no conversion).
    // VERIFY(1070): firing is gated on the same resolver PHASE3 port (no contact
    // plane is stamped for a CONTACT mover until `step_up` lands).
    let wall_normal = t
        .collision_info
        .last_known_contact_plane
        .map(|plane| plane.normal);
    // cell_changed ← the settled cell's id differs from begin's. Phase B
    // validated the single-cell case (curr keeps begin_cell → false); a real
    // portal-spanning sweep is VERIFY(1070) (needs the live cell graph).
    let cell_changed = curr.objcell_id != begin_cell;
    // state: `find_valid_position` returns a faithful binary 1 (settled) / 0
    // (none) — the per-step Slid/Adjusted codes are internal to the stepping
    // loop and not surfaced by the driver's public `int` return, so OK/Collided
    // IS the complete faithful mapping (Phase B settled: no richer state to
    // marshal).
    let state = if found == 1 {
        TransitionState::OK
    } else {
        TransitionState::Collided
    };

    TransitionOutcome {
        pose,
        wall_normal,
        grounded,
        cell_changed,
        state,
    }
}

// ─── Phase B drift harness ───────────────────────────────────────────────────

/// A/B drift harness (Phase 3 B4 Phase B, 2026-06-28). Builds synthetic INDOOR
/// scenes and runs BOTH the faithful CTransition bridge
/// ([`faithful_find_transitional_position`]) and the existing approximate
/// pipeline ([`find_transitional_position`]) over identical geometry — the SAME
/// floor / wall / ledge populated in BOTH representations: world-space flat
/// triangles for the approximate path AND a cell-local `CellPhysicsBsp` (a
/// single non-solid leaf carrying every polygon, the `test_utils` resolver
/// shape) for the faithful path.
///
/// Its job is to catch MARSHALLING bugs (WorldPosition↔Position, grounded /
/// wall_normal mapping, cell_changed, in-bounds), NOT to demand bit-parity: the
/// two solvers legitimately differ (BSP swept-sphere vs flat-tri clamp), so
/// where they should agree we assert within an explicit tolerance, and where
/// they legitimately differ we assert the faithful-path INVARIANTS (terminates,
/// grounded-when-on-floor, pose in the cell AABB) and document the divergence.
#[cfg(test)]
mod drift {
    use super::{faithful_find_transitional_position, FaithfulMover, SceneWorld};
    use crate::spatial::entity_collision::EntityCollider;
    use crate::spatial::scene::{CellPhysicsBsp, SpatialScene};
    use crate::spatial::transition::{
        find_transitional_position, ObjectInfo, TransitionEnv, TransitionGates, TransitionInput,
        TransitionOutcome,
    };
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Aabb, Guid, Plane, Quaternion, Sphere, Triangle, Vector3};
    use holtburger_dat::physics::{BspLeaf, BspNode, ResolvedPolygon};
    use holtburger_dat::transition::frame_transform::Frame;
    use holtburger_dat::transition::types::{object_info_state, CTransition, Position};
    use std::collections::HashMap;

    // Indoor landblock 0x1234 / cell 0x0100 (low word ≥ 0x100 ⇒ `is_indoors`).
    const LB_ID: u32 = 0x1234_0100;
    const CELL_ID: u32 = 0x1234_0100;
    // landblock high-byte coords: X = 0x12 = 18, Y = 0x34 = 52.
    const LB_BASE_X: f32 = 18.0 * 192.0; // 3456
    const LB_BASE_Y: f32 = 52.0 * 192.0; // 9984
    // Floor centre, landblock-local.
    const FCX: f32 = 10.0;
    const FCY: f32 = 10.0;
    // World floor height + half-extent.
    const FLOOR_WZ: f32 = 5.0;
    const HE: f32 = 8.0;
    const WALL_X_LOCAL: f32 = 1.0; // cell-local x of the wall face
    const WALL_H: f32 = 3.0;
    const LEDGE_DROP: f32 = 0.5; // < step_down_height (1.5) ⇒ a step-down, not a fall
    const SINK: f32 = 0.1; // how far the end pose dips below the floor (gravity stand-in)

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// Cell origin in WORLD coords — the floor centre at the floor height.
    fn cell_origin() -> Vector3 {
        v(LB_BASE_X + FCX, LB_BASE_Y + FCY, FLOOR_WZ)
    }

    /// An indoor pose: `coords` are landblock-local, z is the world feet height.
    fn pose_at(x: f32, y: f32, z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(LB_ID),
            coords: v(x, y, z),
            rotation: Quaternion::identity(),
        }
    }

    fn gates() -> TransitionGates {
        TransitionGates {
            step_up_down: true,
            walkable_step_down: false,
            landing_walkable: false,
            water_collision: false,
            terrain_walkable_gate: false,
            local_envcell_entry: true,
            ramp_floor_snap_fix: true,
            skip_parented_entities: true,
            walkable_reinsert_probe: false,
        }
    }

    fn input_for(begin: WorldPosition, end: WorldPosition) -> TransitionInput {
        TransitionInput {
            begin,
            end,
            object: ObjectInfo::for_local_player(None, None, true, Guid(0x5000_0001)),
            airborne: false,
            descending: true,
            force_grounded: false,
            gates: gates(),
            last_known_wall_normal: None,
            frames_stationary_fall: 0,
        }
    }

    fn radius() -> f32 {
        ObjectInfo::for_local_player(None, None, true, Guid(1)).radius
    }

    // ── poly + scene builders (single non-solid leaf carrying every poly) ──

    fn poly(verts: Vec<Vector3>) -> ResolvedPolygon {
        let plane = ResolvedPolygon::make_plane(&verts).expect("non-degenerate poly");
        ResolvedPolygon {
            num_points: verts.len(),
            vertices: verts,
            plane,
        }
    }

    /// Cell-local floor square at z=`zl`, x∈[xlo,xhi], y∈[-HE,HE], +Z normal.
    fn floor_poly_local(xlo: f32, xhi: f32, zl: f32) -> ResolvedPolygon {
        poly(vec![
            v(xlo, -HE, zl),
            v(xhi, -HE, zl),
            v(xhi, HE, zl),
            v(xlo, HE, zl),
        ])
    }

    /// World floor triangles (two), z=`wz`, x∈[xlo,xhi] world, y∈[ylo,yhi] world.
    fn floor_tris_world(xlo: f32, xhi: f32, ylo: f32, yhi: f32, wz: f32) -> Vec<Triangle> {
        vec![
            Triangle::new(v(xlo, ylo, wz), v(xhi, ylo, wz), v(xhi, yhi, wz)),
            Triangle::new(v(xlo, ylo, wz), v(xhi, yhi, wz), v(xlo, yhi, wz)),
        ]
    }

    /// One non-solid leaf carrying every poly id (the `test_utils::Scene`
    /// resolver shape — BSP descent is separately tested in holtburger-dat; the
    /// swept-collision walk tests every poly in this leaf each step).
    fn one_leaf(polys: &HashMap<u16, ResolvedPolygon>) -> BspNode {
        let mut ids: Vec<u16> = polys.keys().copied().collect();
        ids.sort_unstable();
        BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: None, // no bounding reject — always descend
            poly_ids: ids,
        })
    }

    fn bsp_from(polys: HashMap<u16, ResolvedPolygon>) -> CellPhysicsBsp {
        CellPhysicsBsp {
            tree: one_leaf(&polys),
            polys,
            origin: cell_origin(),
            orientation: Quaternion::identity(),
        }
    }

    struct DriftEnv {
        scene: SpatialScene,
    }

    impl TransitionEnv for DriftEnv {
        fn scene(&self) -> &SpatialScene {
            &self.scene
        }
        fn terrain_height_at(&self, _x: f32, _y: f32) -> Option<f32> {
            None
        }
        fn terrain_normal_at(&self, _x: f32, _y: f32) -> Option<Vector3> {
            None
        }
        fn water_depth_at(&self, _x: f32, _y: f32) -> f32 {
            0.0
        }
        fn is_entirely_water_cell_at(&self, _x: f32, _y: f32) -> bool {
            false
        }
        fn entity_colliders_near(
            &self,
            _pose: &WorldPosition,
            _prefilter_dist: f32,
            _exclude: Guid,
            _skip_parented: bool,
        ) -> Vec<EntityCollider> {
            Vec::new()
        }
    }

    /// Seed the cell AABB (so `current_cell` resolves the indoor pose) + the
    /// world-space floor/wall triangles into the scene's flat-tri index.
    fn seed_common(scene: &mut SpatialScene, tris: Vec<Triangle>) {
        let o = cell_origin();
        scene.insert_cell_aabb(
            CELL_ID,
            Aabb::new(
                v(o.x - HE, o.y - HE, FLOOR_WZ - LEDGE_DROP - 0.5),
                v(o.x + HE, o.y + HE, FLOOR_WZ + 10.0),
            ),
        );
        for t in tris {
            scene.insert_cell_triangle(CELL_ID, t);
        }
    }

    fn flat_floor_env() -> DriftEnv {
        let o = cell_origin();
        let mut polys = HashMap::new();
        polys.insert(1u16, floor_poly_local(-HE, HE, 0.0));
        let mut scene = SpatialScene::new();
        scene.insert_cell_physics_bsp(CELL_ID, bsp_from(polys));
        seed_common(
            &mut scene,
            floor_tris_world(o.x - HE, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ),
        );
        DriftEnv { scene }
    }

    fn wall_env() -> DriftEnv {
        let o = cell_origin();
        let mut polys = HashMap::new();
        polys.insert(1u16, floor_poly_local(-HE, HE, 0.0));
        // Vertical wall quad at x=WALL_X_LOCAL, y∈[-HE,HE], z∈[0,WALL_H], N=−X
        // (faces the approaching +x player). N.z = 0 ⇒ a wall, not a floor.
        polys.insert(
            2u16,
            poly(vec![
                v(WALL_X_LOCAL, -HE, 0.0),
                v(WALL_X_LOCAL, -HE, WALL_H),
                v(WALL_X_LOCAL, HE, WALL_H),
                v(WALL_X_LOCAL, HE, 0.0),
            ]),
        );
        let mut scene = SpatialScene::new();
        scene.insert_cell_physics_bsp(CELL_ID, bsp_from(polys));
        let mut tris = floor_tris_world(o.x - HE, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ);
        let wx = o.x + WALL_X_LOCAL;
        tris.push(Triangle::new(
            v(wx, o.y - HE, FLOOR_WZ),
            v(wx, o.y - HE, FLOOR_WZ + WALL_H),
            v(wx, o.y + HE, FLOOR_WZ + WALL_H),
        ));
        tris.push(Triangle::new(
            v(wx, o.y - HE, FLOOR_WZ),
            v(wx, o.y + HE, FLOOR_WZ + WALL_H),
            v(wx, o.y + HE, FLOOR_WZ),
        ));
        seed_common(&mut scene, tris);
        DriftEnv { scene }
    }

    fn ledge_env() -> DriftEnv {
        let o = cell_origin();
        let mut polys = HashMap::new();
        polys.insert(1u16, floor_poly_local(-HE, 0.0, 0.0)); // high (x<0)
        polys.insert(2u16, floor_poly_local(0.0, HE, -LEDGE_DROP)); // low (x>0)
        let mut scene = SpatialScene::new();
        scene.insert_cell_physics_bsp(CELL_ID, bsp_from(polys));
        let mut tris = floor_tris_world(o.x - HE, o.x, o.y - HE, o.y + HE, FLOOR_WZ);
        tris.extend(floor_tris_world(
            o.x,
            o.x + HE,
            o.y - HE,
            o.y + HE,
            FLOOR_WZ - LEDGE_DROP,
        ));
        seed_common(&mut scene, tris);
        DriftEnv { scene }
    }

    fn run_ab(env: &DriftEnv, input: &TransitionInput) -> (TransitionOutcome, TransitionOutcome) {
        let approx = find_transitional_position(env, input);
        let faithful = faithful_find_transitional_position(env, input);
        (approx, faithful)
    }

    /// Replicate the bridge's CTransition construction but return the RAW driver
    /// state, so the probe can inspect contact_plane / ON_WALKABLE / walkable —
    /// the candidate grounded signals.
    fn raw_drive(env: &DriftEnv, input: &TransitionInput) -> (CTransition, i32) {
        let scene = env.scene();
        let begin_cell = scene.current_cell(&input.begin);
        let end_cell = scene.current_cell(&input.end);
        let mut bf = Frame::identity();
        bf.origin = input.begin.global_coords();
        let begin_pos = Position {
            objcell_id: begin_cell,
            frame: bf,
        };
        let mut ef = Frame::identity();
        ef.origin = input.end.global_coords();
        let end_pos = Position {
            objcell_id: end_cell,
            frame: ef,
        };
        let r = input.object.radius;
        let h = input.object.height;
        let spheres = [
            Sphere {
                center: v(0.0, 0.0, r),
                radius: r,
            },
            Sphere {
                center: v(0.0, 0.0, (h - r).max(r)),
                radius: r,
            },
        ];
        let mut t = CTransition::new();
        t.object_info.scale = 1.0;
        t.object_info.state = input.object.state;
        t.object_info.step_up_height = input.object.step_up_height;
        t.object_info.step_down_height = input.object.step_down_height;
        t.object_info.ethereal = input.object.ethereal;
        t.init_sphere(2, &spheres, 1.0);
        t.init_path(Some(begin_cell), Some(&begin_pos), &end_pos);
        let world = SceneWorld::new(scene);
        let mover = FaithfulMover { has_gravity: true };
        let found = t.find_valid_position(&world, &mover);
        (t, found)
    }

    fn assert_in_cell_aabb(env: &DriftEnv, out: &TransitionOutcome) {
        let aabb = env.scene.cell_aabb(CELL_ID).expect("cell aabb");
        let g = out.pose.global_coords();
        let m = radius() + 1e-3;
        assert!(g.x >= aabb.min.x - m && g.x <= aabb.max.x + m, "x {} oob", g.x);
        assert!(g.y >= aabb.min.y - m && g.y <= aabb.max.y + m, "y {} oob", g.y);
        assert!(g.z >= aabb.min.z - m && g.z <= aabb.max.z + m, "z {} oob", g.z);
    }

    // ── Probe: dump the A/B outcomes AND the raw driver internals ──
    #[test]
    fn probe_ab_observations() {
        let cases: [(&str, fn() -> DriftEnv, WorldPosition, WorldPosition); 4] = [
            (
                "flat-walk",
                flat_floor_env as fn() -> DriftEnv,
                pose_at(FCX, FCY, FLOOR_WZ),
                pose_at(FCX + 1.3, FCY, FLOOR_WZ - SINK),
            ),
            (
                "wall",
                wall_env as fn() -> DriftEnv,
                pose_at(FCX, FCY, FLOOR_WZ),
                pose_at(FCX + 2.0, FCY, FLOOR_WZ - SINK),
            ),
            (
                "ledge",
                ledge_env as fn() -> DriftEnv,
                pose_at(FCX - 2.0, FCY, FLOOR_WZ),
                pose_at(FCX + 2.0, FCY, FLOOR_WZ - LEDGE_DROP - SINK),
            ),
            (
                "no-sink-flat",
                flat_floor_env as fn() -> DriftEnv,
                pose_at(FCX, FCY, FLOOR_WZ),
                pose_at(FCX + 1.0, FCY, FLOOR_WZ),
            ),
        ];
        for (name, build, begin, end) in cases {
            let env = build();
            let bc = env.scene.current_cell(&begin);
            let (a, f) = run_ab(&env, &input_for(begin, end));
            let (t, found) = raw_drive(&env, &input_for(begin, end));
            let st = t.object_info.state;
            eprintln!(
                "[{name}] begin_cell={:#x} found={found}\n  APPROX   pose=({:.4},{:.4},{:.4}) grounded={} cell_chg={} state={:?} wall={:?}\n  FAITHFUL pose=({:.4},{:.4},{:.4}) grounded={} cell_chg={} state={:?} wall={:?}\n  RAW      curr=({:.4},{:.4},{:.4}) CONTACT={} ON_WALKABLE={} walkable={} contact_plane={:?} lastknown={:?}",
                bc,
                a.pose.coords.x, a.pose.coords.y, a.pose.coords.z, a.grounded, a.cell_changed, a.state, a.wall_normal,
                f.pose.coords.x, f.pose.coords.y, f.pose.coords.z, f.grounded, f.cell_changed, f.state, f.wall_normal,
                t.sphere_path.curr_pos.frame.origin.x, t.sphere_path.curr_pos.frame.origin.y, t.sphere_path.curr_pos.frame.origin.z,
                st & object_info_state::CONTACT != 0,
                st & object_info_state::ON_WALKABLE != 0,
                t.sphere_path.walkable.is_some(),
                t.collision_info.contact_plane.map(|p| (p.normal, p.d)),
                t.collision_info.last_known_contact_plane.map(|p| (p.normal, p.d)),
            );
        }
    }

    // Direct-resolver isolation: build the cell handle and call its
    // `find_collisions` with a single step whose low sphere deeply penetrates
    // the wall — tells us whether the cell adapter + resolver detect geometry.
    #[test]
    fn diag_resolver_direct() {
        use holtburger_dat::transition::objcell::CellWorld;
        let env = wall_env();
        let world = SceneWorld::new(&env.scene);
        let cell = world.get_visible(CELL_ID);
        eprintln!("get_visible({CELL_ID:#x}) is_some = {}", cell.is_some());
        let Some(cell) = cell else {
            return;
        };
        let o = cell_origin();
        let r = radius();
        let h = ObjectInfo::for_local_player(None, None, true, Guid(1)).height;
        let spheres = [
            Sphere {
                center: v(0.0, 0.0, r),
                radius: r,
            },
            Sphere {
                center: v(0.0, 0.0, (h - r).max(r)),
                radius: r,
            },
        ];
        let mut t = CTransition::new();
        t.object_info.scale = 1.0;
        t.object_info.state = object_info_state::CONTACT;
        t.init_sphere(2, &spheres, 1.0);
        // curr just shy of the wall, check deep inside the wall (low sphere
        // centre at world x = wall face = o.x + WALL_X_LOCAL).
        let mut curr = Frame::identity();
        curr.origin = v(o.x + WALL_X_LOCAL - 0.5, o.y, FLOOR_WZ);
        let mut chk = Frame::identity();
        chk.origin = v(o.x + WALL_X_LOCAL, o.y, FLOOR_WZ);
        t.sphere_path.curr_pos = Position {
            objcell_id: CELL_ID,
            frame: curr,
        };
        t.sphere_path.check_pos = Position {
            objcell_id: CELL_ID,
            frame: chk,
        };
        t.sphere_path.curr_cell = Some(CELL_ID);
        t.sphere_path.check_cell = Some(CELL_ID);
        t.sphere_path.cache_global_sphere(None);
        let code = cell.find_collisions(&mut t);
        eprintln!(
            "WALL find_collisions → {code} | collision_normal={:?} contact_plane={:?} walkable={} ON_WALKABLE={}",
            t.collision_info.collision_normal,
            t.collision_info.contact_plane.map(|p| (p.normal, p.d)),
            t.sphere_path.walkable.is_some(),
            t.object_info.state & object_info_state::ON_WALKABLE != 0,
        );
        // also probe the floor: low sphere sunk 0.2 below the floor.
        let mut t2 = CTransition::new();
        t2.object_info.scale = 1.0;
        t2.object_info.state = object_info_state::CONTACT;
        t2.init_sphere(2, &spheres, 1.0);
        let mut c2 = Frame::identity();
        c2.origin = v(o.x - 3.0, o.y, FLOOR_WZ);
        let mut k2 = Frame::identity();
        k2.origin = v(o.x - 2.7, o.y, FLOOR_WZ - 0.2);
        t2.sphere_path.curr_pos = Position {
            objcell_id: CELL_ID,
            frame: c2,
        };
        t2.sphere_path.check_pos = Position {
            objcell_id: CELL_ID,
            frame: k2,
        };
        t2.sphere_path.curr_cell = Some(CELL_ID);
        t2.sphere_path.check_cell = Some(CELL_ID);
        t2.sphere_path.cache_global_sphere(None);
        let code2 = cell.find_collisions(&mut t2);
        eprintln!(
            "FLOOR find_collisions → {code2} | contact_plane={:?} walkable={}",
            t2.collision_info.contact_plane.map(|p| (p.normal, p.d)),
            t2.sphere_path.walkable.is_some(),
        );
        let _ = Plane {
            normal: v(0.0, 0.0, 1.0),
            d: 0.0,
        };
    }

    /// faithful never OVERSHOOTS the requested begin→end displacement (the
    /// driver clamps to the swept path; it can stop short on a hit but never run
    /// past `end`). A real driver-soundness invariant, independent of whether a
    /// collision response fires.
    fn assert_no_overshoot(begin: &WorldPosition, end: &WorldPosition, out: &TransitionOutcome) {
        let req = Vector3::new(
            end.coords.x - begin.coords.x,
            end.coords.y - begin.coords.y,
            end.coords.z - begin.coords.z,
        );
        let got = Vector3::new(
            out.pose.coords.x - begin.coords.x,
            out.pose.coords.y - begin.coords.y,
            out.pose.coords.z - begin.coords.z,
        );
        assert!(
            got.length() <= req.length() + 1e-2,
            "overshoot: |got|={} > |req|={}",
            got.length(),
            req.length()
        );
    }

    /// The pose round-trips the driver's settled `curr_pos.frame.origin` back
    /// through `begin`'s landblock origin — the marshalling math the bridge owns.
    fn assert_pose_roundtrips_driver(env: &DriftEnv, input: &TransitionInput, out: &TransitionOutcome) {
        let (t, _) = raw_drive(env, input);
        let curr = t.sphere_path.curr_pos.frame.origin;
        let g = out.pose.global_coords();
        assert!(
            (g.x - curr.x).abs() < 1e-3 && (g.y - curr.y).abs() < 1e-3 && (g.z - curr.z).abs() < 1e-3,
            "pose {:?} does not round-trip driver curr {:?}",
            g,
            curr
        );
    }

    // ── (a) walk across a flat floor ──
    // Faithful invariants: terminates, in-bounds, advances, no overshoot, pose
    // round-trips, single-cell (no cell change). The approximate path GROUNDS
    // (validates the A/B machinery). DIVERGENCE (documented, VERIFY(1070)):
    // faithful does NOT latch grounded yet — the resolver's `step_up` is a
    // PHASE3 stub, so a CONTACT mover stamps no contact plane on flat ground.
    #[test]
    fn flat_walk_advances_and_marshals() {
        let env = flat_floor_env();
        let begin = pose_at(FCX, FCY, FLOOR_WZ);
        let end = pose_at(FCX + 1.3, FCY, FLOOR_WZ - SINK);
        let input = input_for(begin, end);
        let (a, f) = run_ab(&env, &input);
        assert_in_cell_aabb(&env, &f);
        assert_no_overshoot(&begin, &end, &f);
        assert_pose_roundtrips_driver(&env, &input, &f);
        assert!(!f.cell_changed, "single-cell move ⇒ no cell change");
        assert!(f.pose.coords.x > begin.coords.x, "faithful advanced");
        assert!(a.grounded, "approximate path grounds on the flat floor");
        // The faithful pose stays at the floor surface (it does not punch
        // through): within a radius of the approximate snap height.
        assert!(
            (f.pose.coords.z - a.pose.coords.z).abs() < radius(),
            "z near approx floor: faithful {} vs approx {}",
            f.pose.coords.z,
            a.pose.coords.z
        );
    }

    // ── (b) walk into a wall ──
    // The approximate path STOPS within a radius of the wall (validated). The
    // faithful path TERMINATES, stays in-bounds, never overshoots, and round-
    // trips its driver pose. DIVERGENCE (documented, VERIFY(1070)): faithful
    // does not yet HARD-STOP at the wall — `step_sphere_up` falls through to the
    // resolver's slide fallback because `CTransition::step_up` is a PHASE3 stub,
    // so the lateral motion is not clamped to the wall face. When the resolver's
    // step_up/find_walkable port lands (Phase C), the stronger parity assertion
    // (`f.x <= wall_x + radius`) becomes the bar for the 1070 A/B.
    #[test]
    fn wall_approx_stops_faithful_marshals() {
        let env = wall_env();
        let begin = pose_at(FCX, FCY, FLOOR_WZ);
        let end = pose_at(FCX + 2.0, FCY, FLOOR_WZ - SINK);
        let input = input_for(begin, end);
        let (a, f) = run_ab(&env, &input);
        let wall_x = FCX + WALL_X_LOCAL;
        // Approximate path stops within ~one radius of the wall face.
        assert!(
            a.pose.coords.x <= wall_x + 1e-2 && a.pose.coords.x >= wall_x - radius() - 0.2,
            "approx stop near wall: {}",
            a.pose.coords.x
        );
        assert!(a.grounded);
        assert!(a.wall_normal.is_some(), "approx surfaces the wall normal");
        // Faithful marshalling invariants hold regardless of the response.
        assert_in_cell_aabb(&env, &f);
        assert_no_overshoot(&begin, &end, &f);
        assert_pose_roundtrips_driver(&env, &input, &f);
    }

    // ── (b') Phase C: a resident STATIC object stops the mover ──
    // The cell ENVIRONMENT is a bare floor; the WALL is a resident static object
    // fed via `cell_static_physics_bsp` (NOT the env BSP). A player walking into
    // it must STOP — exercising `SceneObjCell::find_obj_collisions`. Control: the
    // SAME scene minus the static walks straight through, proving the static BSP
    // (not the floor/env) is what blocks.
    #[test]
    fn faithful_static_object_stops_mover() {
        fn floor_only_scene() -> SpatialScene {
            let o = cell_origin();
            let mut floor = HashMap::new();
            floor.insert(1u16, floor_poly_local(-HE, HE, 0.0));
            let mut scene = SpatialScene::new();
            scene.insert_cell_physics_bsp(CELL_ID, bsp_from(floor));
            seed_common(
                &mut scene,
                floor_tris_world(o.x - HE, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ),
            );
            scene
        }
        // A static wall quad at cell-local x=WALL_X_LOCAL (N=−X faces the +x
        // approach), framed to world at the cell origin (identity orientation).
        fn static_wall_bsp() -> CellPhysicsBsp {
            let mut wallp = HashMap::new();
            wallp.insert(
                1u16,
                poly(vec![
                    v(WALL_X_LOCAL, -HE, 0.0),
                    v(WALL_X_LOCAL, -HE, WALL_H),
                    v(WALL_X_LOCAL, HE, WALL_H),
                    v(WALL_X_LOCAL, HE, 0.0),
                ]),
            );
            bsp_from(wallp)
        }

        let begin = pose_at(FCX, FCY, FLOOR_WZ);
        let end = pose_at(FCX + 2.0, FCY, FLOOR_WZ); // horizontal walk (grounded)
        let input = input_for(begin, end);
        let wall_x = FCX + WALL_X_LOCAL; // landblock-local x of the wall face

        // WITH the static wall.
        let mut scene = floor_only_scene();
        scene.insert_cell_static_physics_bsp(CELL_ID, static_wall_bsp());
        assert_eq!(scene.cell_static_physics_bsp_count(), 1);
        let env = DriftEnv { scene };
        let with = faithful_find_transitional_position(&env, &input);

        // CONTROL: no static (env floor only).
        let ctrl = DriftEnv { scene: floor_only_scene() };
        let without = faithful_find_transitional_position(&ctrl, &input);

        eprintln!(
            "static-object: WITH x={:.4}  WITHOUT x={:.4}  wall_x={wall_x}",
            with.pose.coords.x, without.pose.coords.x
        );

        // The static stops the mover at/short of the wall face …
        assert!(
            with.pose.coords.x <= wall_x + 1e-2,
            "static object did not stop the mover: x={} wall_x={wall_x}",
            with.pose.coords.x
        );
        // … and the control (no static) advances clearly further (the static BSP,
        // not the floor, is what blocks).
        assert!(
            without.pose.coords.x > with.pose.coords.x + 0.25,
            "control should advance past the stopped position: with={} without={}",
            with.pose.coords.x, without.pose.coords.x
        );
        assert_in_cell_aabb(&env, &with);
    }

    // ── (c) step down a ledge ──
    #[test]
    fn ledge_advances_and_marshals() {
        let env = ledge_env();
        let begin = pose_at(FCX - 2.0, FCY, FLOOR_WZ);
        let end = pose_at(FCX + 2.0, FCY, FLOOR_WZ - LEDGE_DROP - SINK);
        let input = input_for(begin, end);
        let (a, f) = run_ab(&env, &input);
        assert_in_cell_aabb(&env, &f);
        assert_no_overshoot(&begin, &end, &f);
        assert_pose_roundtrips_driver(&env, &input, &f);
        assert!(f.pose.coords.x > begin.coords.x, "faithful advanced past the ledge");
        assert!(a.grounded, "approximate path stays grounded over the ledge");
        // Faithful tracks down toward the lower floor (does not fly off).
        assert!(
            f.pose.coords.z <= begin.coords.z + 1e-2 && f.pose.coords.z >= FLOOR_WZ - LEDGE_DROP - 0.2,
            "faithful z descends toward the low floor: {}",
            f.pose.coords.z
        );
    }

    // ── (d) the faithful path always TERMINATES + stays inside the cell AABB ──
    // (the bounded `calc_num_steps` loop / recursion-depth guard never trips).
    #[test]
    fn faithful_terminates_and_stays_in_bounds() {
        let builders: [fn() -> DriftEnv; 3] = [flat_floor_env, wall_env, ledge_env];
        for build in builders {
            let env = build();
            let begin = pose_at(FCX, FCY, FLOOR_WZ);
            // A long diagonal that, unbounded, would run far — must terminate.
            let end = pose_at(FCX + 5.0, FCY + 5.0, FLOOR_WZ - SINK);
            let input = input_for(begin, end);
            let f = faithful_find_transitional_position(&env, &input);
            assert_in_cell_aabb(&env, &f);
            assert_no_overshoot(&begin, &end, &f);
            assert_pose_roundtrips_driver(&env, &input, &f);
            assert!(!f.cell_changed, "single-cell ⇒ no cell change");
        }
    }

    // ── Delegation routing (pure marshalling, fully RESOLVED on the laptop) ──
    // The dispatcher's faithful arm must be byte-identical to the approximate
    // path for the cases Phase A delegates: OUTDOOR poses and indoor poses whose
    // cell has no physics BSP (the pre-bake guard).
    #[test]
    fn outdoor_pose_delegates_to_approximate() {
        // Outdoor landblock (low word 0 ⇒ !is_indoors): the faithful entry
        // delegates straight to the approximate pipeline.
        let mut scene = SpatialScene::new();
        // No geometry needed; an empty outdoor scene exercises pure delegation.
        let _ = &mut scene;
        let env = DriftEnv { scene };
        let begin = WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: v(50.0, 50.0, 10.0),
            rotation: Quaternion::identity(),
        };
        let mut end = begin;
        end.coords.x += 1.3;
        let input = input_for(begin, end);
        let a = find_transitional_position(&env, &input);
        let f = faithful_find_transitional_position(&env, &input);
        assert_eq!(a.pose, f.pose, "outdoor delegates byte-identically");
        assert_eq!(a.grounded, f.grounded);
        assert_eq!(a.cell_changed, f.cell_changed);
    }

    #[test]
    fn indoor_no_bsp_delegates_to_approximate() {
        // Indoor pose but the cell has NO physics BSP → the pre-bake guard
        // delegates to the approximate path. Seed only a cell AABB (+ triangles
        // so the approximate path has geometry), no `cell_physics_bsp`.
        let o = cell_origin();
        let mut scene = SpatialScene::new();
        seed_common(
            &mut scene,
            floor_tris_world(o.x - HE, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ),
        );
        let env = DriftEnv { scene };
        let begin = pose_at(FCX, FCY, FLOOR_WZ);
        let end = pose_at(FCX + 1.0, FCY, FLOOR_WZ - SINK);
        let input = input_for(begin, end);
        // Confirm the guard precondition: indoor pose, no BSP for its cell.
        assert!(begin.is_indoors());
        assert!(env.scene.cell_physics_bsp(env.scene.current_cell(&begin)).is_none());
        let a = find_transitional_position(&env, &input);
        let f = faithful_find_transitional_position(&env, &input);
        assert_eq!(a.pose, f.pose, "indoor-no-BSP delegates byte-identically");
        assert_eq!(a.grounded, f.grounded);
    }
}
