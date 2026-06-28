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
//! are identity. Marshalling correctness (WorldPosition↔Position, grounded /
//! wall_normal mapping, cross-landblock carry) is validated in Phase B — the
//! ambiguous readings are tagged `// VERIFY(PhaseB):`.
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
use holtburger_common::{Quaternion, Sphere, Vector3};

use holtburger_dat::transition::driver_validate::MovingObjectPhysics;
use holtburger_dat::transition::frame_transform::Frame;
use holtburger_dat::transition::objcell::{
    CObjCell, CellArrayApi, CellWorld, LandblockRef, PhysicsObjRef, WaterType,
};
use holtburger_dat::transition::types::{CTransition, LandDefs, ObjCellHandle, Position, SpherePath};

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
        // VERIFY(PhaseB): wire EnvCell water_type through the cell adapter.
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

    /// `CEnvCell::find_transit_cells` (acclient.c:348250) — flood the portal
    /// neighbour cell ids into the ring. Phase A appends them with NULL handles:
    /// the PRIMARY (player's own) cell is collision-tested faithfully via
    /// `world.get_visible(check_cell)`; cross-portal collision (resolving the
    /// neighbour handles) needs the scene reference a `'static` cell cannot
    /// hold — VERIFY(PhaseB): a shared resolver for portal-spanning sweeps.
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

    /// `CEnvCell::find_collisions` (acclient.c:347816) — env collisions, then
    /// object collisions. Phase A: cache the swept sphere into the cell-local
    /// frame and run the Phase-2 resolver over the physics BSP (env-cell
    /// faithful); object collisions are identity (`find_obj_collisions` → 1).
    fn find_collisions(&self, transition: &mut CTransition) -> i32 {
        let Some(bsp) = self.bsp.as_ref() else {
            // No narrow-phase geometry → OK (no collision). Matches the existing
            // pipeline's unbaked-cell pass-through.
            return TransitionState::OK as i32;
        };
        let scale = if transition.object_info.scale != 0.0 {
            transition.object_info.scale
        } else {
            1.0
        };
        // SPHEREPATH::cache_localspace_sphere(&this->pos, scale) — the resolver's
        // localspace_* input.
        transition
            .sphere_path
            .cache_localspace_sphere(&self.pos, scale);
        // BSPTREE::find_collisions(transition, scale) over the cell-local tree.
        let env = holtburger_dat::transition::resolver_find::find_collisions(
            &bsp.tree,
            transition,
            scale,
            &bsp.polys,
        );
        if env != TransitionState::OK as i32 {
            return env;
        }
        // Object/static collisions — identity for Phase A (Phase C).
        self.find_obj_collisions(transition)
    }

    /// Statics / object collisions are identity in Phase A (Phase C wires them).
    fn find_obj_collisions(&self, _transition: &mut CTransition) -> i32 {
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
        let portal_neighbours = self.scene.cell_portal_neighbours(cell_id).to_vec();
        if bsp.is_none() && portal_neighbours.is_empty() {
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
    /// VERIFY(PhaseB): wire `add_all_outside_cells_sphere` + a scene `Landscape`
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
    // capsule, matching `cell_physics_bsp_solid`). VERIFY(PhaseB): a non-vertical
    // mover orientation would need the player rotation basis here.
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
    // The player is gravity-affected (GRAVITY_PS). VERIFY(PhaseB): thread the
    // real per-object gravity bit if non-player movers route here.
    let mover = FaithfulMover { has_gravity: true };
    let found = t.find_valid_position(&world, &mover);

    // ── Marshal CTransition → TransitionOutcome ──
    // curr_pos.frame.origin is the settled feet position in WORLD space; convert
    // back to landblock-local coords. VERIFY(PhaseB): cross-landblock rebucket
    // (indoor dungeons are single-landblock, so begin's landblock is correct).
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

    // grounded ← SPHEREPATH::walkable.is_some() (the supporting poly latch).
    // VERIFY(PhaseB): the walkable latch is set only by the resolver's walk
    // branches; the grounded/airborne mapping needs A/B validation.
    let grounded = t.sphere_path.walkable.is_some();
    // wall_normal ← COLLISIONINFO::last_known_contact_plane normal (Plane and
    // Vector3 are the shared holtburger_common types — no conversion).
    let wall_normal = t
        .collision_info
        .last_known_contact_plane
        .map(|plane| plane.normal);
    let cell_changed = curr.objcell_id != begin_cell;
    // state: find_valid_position returns 1 (settled) / 0 (none). VERIFY(PhaseB):
    // map the richer per-step TransitionState (Slid/Adjusted) once validated.
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
