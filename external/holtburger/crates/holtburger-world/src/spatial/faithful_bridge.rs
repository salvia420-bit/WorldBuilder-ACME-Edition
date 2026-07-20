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

use holtburger_dat::physics::{CellBound, ResolvedPolygon};
use holtburger_dat::transition::driver_validate::MovingObjectPhysics;
use holtburger_dat::transition::frame_transform::Frame;
use holtburger_dat::transition::objcell::{
    add_all_outside_cells_sphere, gid_to_lcoord, lcoord_to_cellid, CObjCell, CellArrayApi,
    CellWorld, Landscape, LandDefsSeam, LandblockRef, PhysicsObjRef, WaterType, CELL_SIZE,
};
use holtburger_dat::transition::terrain_collision::{cell_terrain_polys, find_terrain_poly};
use holtburger_dat::transition::types::{
    object_info_state, CTransition, CellArray, LandDefs, ObjCellHandle, Position, SpherePath,
};

use super::collision::TransitionState;
use super::scene::{CellMembership, CellPhysicsBsp, SpatialScene};
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

/// How many portal levels [`SceneWorld::build_cell`] resolves ahead so the
/// `find_cell_list` flood can reach multi-hop transit cells (E3.3). Retail's
/// flood is self-terminating via the sphere-vs-cell gate; this is the build-time
/// depth that gate operates within. `2` covers a mover crossing two portals in a
/// single frame (the realistic worst case) while keeping the bounded build cheap;
/// the gate prunes any neighbour the spheres don't actually reach.
const MAX_PORTAL_HOPS: u32 = 2;

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
    /// Phase E3.2 — the precise cell-membership BSP (`CellStruct.cell_bsp`,
    /// cloned from [`SpatialScene::cell_membership`]). When present,
    /// [`Self::point_in_cell`] walks it (`BspNode::point_inside_cell`, the
    /// faithful `BSPNODE::point_inside_cell_bsp` port, acclient.c:362944) instead
    /// of the looser AABB — precise cross-portal re-seat. `None` ⇒ AABB fallback.
    membership: Option<CellMembership>,
    /// `((CEnvCell*)this)->stab_list` — the portal-visible neighbour cell ids
    /// (the cell ring `find_transit_cells` floods). Kept for the
    /// `do_not_load_cells` stab-list prune (`visible_cells()`).
    portal_neighbours: Vec<u32>,
    /// Phase E2/E3.3 (cross-portal): the portal neighbours' RESOLVED collision
    /// handles (`CCellPortal::GetOtherCell` → `CEnvCell::GetVisible`,
    /// acclient.c:362341), each paired with that neighbour's cell-membership BSP
    /// (`Option<CellMembership>`) for the sphere-vs-cell flood gate. Populated at
    /// build time; with E3.3 the build is MULTI-HOP (bounded by
    /// [`MAX_PORTAL_HOPS`]) — a neighbour carries its OWN `resolved_neighbours`, so
    /// the `find_cell_list` loop (which re-reads `num_cells`) floods transit cells
    /// across several portals in turn. `find_transit_cells` emits each with
    /// `Some(handle)` — but only when the moving spheres intersect the neighbour
    /// (the gate, see there) — so `check_other_cells` collides the mover against
    /// the reachable neighbour cells across the portal (without this the neighbour
    /// carried a NULL handle and was silently skipped → cross-portal walk-through).
    /// Empty for leaf-depth neighbours and outdoor cells. Each cell collides in its
    /// OWN world frame (non-Euclidean-safe: portal connectivity, not spatial
    /// overlap — gmriggs/trevis).
    resolved_neighbours: Vec<(u32, ObjCellHandle, Option<CellMembership>)>,
    /// Phase D / WS3: the OUTDOOR land cell's two collision triangles
    /// (`CLandCell::polygons`), in this cell's LANDBLOCK-local frame (WS2's
    /// [`cell_terrain_polys`]). `Some` ⇒ this is an outdoor `CLandCell` and
    /// [`Self::find_collisions`] runs the terrain `FindEnvCollisions` path
    /// (`find_terrain_poly` + `validate_walkable`) instead of the indoor env BSP.
    /// `None` for indoor env cells (mutually exclusive with [`Self::bsp`]).
    terrain_polys: Option<[ResolvedPolygon; 2]>,
    /// Phase D / WS3: the WORLD-space origin of this cell's landblock
    /// (`(blockX·192, blockY·192, 0)`). The terrain polys are landblock-local; the
    /// driver runs the swept sphere in WORLD space, so the terrain path rebases
    /// the global sphere into the landblock frame by subtracting this. This is the
    /// `GetBlockOffset(check_pos, this)` reduction (a pure translation — landblocks
    /// are never rotated) for the same-landblock case the bridge exercises.
    landblock_origin: Vector3,
    /// Phase E3.6: this cell's water type (`CLandBlockStruct::CalcCellWater`,
    /// acclient.c:353608), classified from its 4 corner terrain codes. Drives
    /// [`Self::water_type`] → the unconditional water gate in
    /// [`Self::find_terrain_collisions`]: EntirelyWater ⇒ `get_water_depth` 0.9 ⇒
    /// non-walkable; PartiallyWater ⇒ per-corner wading depth. `NotWater` for
    /// indoor cells and outdoor cells with no resident terrain codes.
    water_type: WaterType,
    /// Phase E3.6: per-corner "is water" flags in the SAME order
    /// [`build_outdoor_cell`] extracts the height corners — `[SW, SE, NW, NE]` =
    /// `[cx*9+cy, (cx+1)*9+cy, cx*9+cy+1, (cx+1)*9+cy+1]`. Used by
    /// [`Self::get_water_depth`] for the PartiallyWater corner lookup (retail
    /// `CLandBlockStruct::calc_water_depth`: 0.45 at a water corner, 0.1 at land).
    corner_is_water: [bool; 4],
}

impl SceneObjCell {
    /// `CLandCell::FindEnvCollisions` (ACE `LandCell.cs:37-65`; decomp
    /// `find_terrain_poly` acclient.c:354859 + `OBJECTINFO::validate_walkable`
    /// :314161). The OUTDOOR terrain collision body, run when this cell carries
    /// terrain triangles ([`SceneObjCell::terrain_polys`]):
    ///   1. rebase the swept sphere's global low point into the landblock-local
    ///      frame (`localPoint = GlobalLowPoint − GetBlockOffset`; in the WORLD-
    ///      space bridge this reduces to `global_low_point − landblock_origin`);
    ///   2. [`find_terrain_poly`] selects the supporting triangle — `None` (off
    ///      the cell footprint) is OK and falls through to statics, exactly ACE's
    ///      `return transitState`;
    ///   3. an entirely-water landblock blocks a non-viewer mover (`Collided`);
    ///   4. `OBJECTINFO::validate_walkable` runs the slope/landing gate (walkable
    ///      allowance, deep-water depth) against the triangle plane and the
    ///      landblock-local check sphere, recording the contact plane / collision
    ///      normal and pushing the sphere out of the surface — the driver's
    ///      `validate_transition` then latches CONTACT / ON_WALKABLE from that
    ///      plane (the grounded signal the marshalling reads).
    ///
    /// The plane and check sphere are both expressed in the landblock-local frame,
    /// which differs from WORLD only by a translation, so the signed-distance
    /// (`v17`) and the push-out offset `validate_walkable` computes are identical
    /// to the WORLD-frame ones and apply correctly to the path's world check_pos.
    fn find_terrain_collisions(&self, transition: &mut CTransition) -> i32 {
        let terrain = match self.terrain_polys.as_ref() {
            Some(t) => t,
            None => return TransitionState::OK as i32,
        };
        // localPoint = GlobalLowPoint − GetBlockOffset(check_pos, this). World
        // frame ⇒ subtract this cell's landblock origin (same-landblock offset).
        let local_low = transition.sphere_path.global_low_point - self.landblock_origin;
        // find_terrain_poly: which triangle sits under the low point? `None` ⇒
        // off the cell ⇒ OK (proceed to statics) — ACE returns `transitState`.
        let walkable = match find_terrain_poly(terrain, local_low) {
            Some(p) => p,
            None => return TransitionState::OK as i32,
        };
        // Entirely-water landblock ⇒ a non-viewer mover is blocked (`Collided`).
        // (Missile is not a movement mover on this path.) Uses the ported
        // `CObjCell::get_block_water_type`; `None` landblock ⇒ NotWater today, so
        // this never fires until live water is wired (WS8). VERIFY(WS8): outdoor
        // water type/depth via the live `WorldState` samplers.
        if self.get_block_water_type() == WaterType::EntirelyWater
            && transition.object_info.state & object_info_state::IS_VIEWER == 0
        {
            return TransitionState::Collided as i32;
        }
        let water_depth = self.get_water_depth(local_low);
        let is_water = self.water_type() != WaterType::NotWater;
        // checkPos = GlobalSphere[0] − GetBlockOffset(check_pos, this).
        let mut check_pos = transition.sphere_path.global_sphere[0];
        check_pos.center = check_pos.center - self.landblock_origin;
        let cell_id = self.cell_id;
        // ValidateWalkable(checkPos, walkable.Plane, isWater, waterDepth, .., ID).
        // Disjoint field borrows of `transition` (object_info shared, path /
        // collision_info mutable).
        let CTransition {
            object_info,
            sphere_path,
            collision_info,
            ..
        } = &mut *transition;
        object_info.validate_walkable(
            &check_pos,
            &walkable.plane,
            is_water,
            water_depth,
            sphere_path,
            collision_info,
            cell_id,
        )
    }
}

impl CObjCell for SceneObjCell {
    fn id(&self) -> u32 {
        self.cell_id
    }

    fn pos(&self) -> &Position {
        &self.pos
    }

    fn water_type(&self) -> WaterType {
        // Phase E3.6: the cell's classified water type (outdoor land cells carry
        // it from their corner terrain codes; indoor cells are NotWater). Drives
        // the unconditional water gate in `find_terrain_collisions`.
        self.water_type
    }

    /// `CObjCell::get_water_depth` (acclient.c:347233) — self-contained on the
    /// outdoor cell (no `myLandBlock_` indirection needed). NotWater ⇒ 0;
    /// EntirelyWater ⇒ 0.9; PartiallyWater ⇒ the wading depth of the cell corner
    /// the point falls in (`CLandBlockStruct::calc_water_depth`): 0.45 at a water
    /// corner, 0.1 at a land corner. `point` is the landblock-local low point (the
    /// frame `find_terrain_collisions` passes); the within-cell quadrant selects
    /// the corner exactly as ACE — `% 24 >= 12` on X ⇒ east, on Y ⇒ north.
    fn get_water_depth(&self, point: Vector3) -> f32 {
        match self.water_type {
            WaterType::NotWater => 0.0,
            WaterType::EntirelyWater => 0.89999998,
            WaterType::PartiallyWater => {
                let east = point.x.rem_euclid(CELL_SIZE) >= CELL_SIZE * 0.5;
                let north = point.y.rem_euclid(CELL_SIZE) >= CELL_SIZE * 0.5;
                // corner_is_water order is [SW, SE, NW, NE].
                let idx = east as usize + 2 * north as usize;
                if self.corner_is_water[idx] {
                    0.44999999
                } else {
                    0.1
                }
            }
        }
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
        // Phase E3.2: precise membership BSP (`CEnvCell::point_in_cell` →
        // `CCellStruct::point_in_cell`, acclient.c:347935/355496) — rebase the
        // world point into the cell's local frame and walk the cell_bsp. Falls
        // back to the AABB when the membership tree isn't resident.
        if let Some(m) = &self.membership {
            return m.tree.point_inside_cell(&m.world_to_local(point));
        }
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
    /// neighbour cells into the ring. Phase E2: the neighbour handles were
    /// resolved at build time (`build_cell_inner` → `GetVisible`), so we emit
    /// them with `Some(handle)` and `check_other_cells` collides the mover
    /// across the portal (the `'static` cell can't borrow the scene, so the
    /// resolution happens at build time rather than here). Non-resident /
    /// unloaded neighbours are simply absent (graceful stale-handle handling —
    /// trevis "stale pointer shenanigans"; a NULL-handle entry would be skipped
    /// by `check_other_cells` anyway and carries no geometry). Phase E3.3:
    /// MULTI-HOP — each neighbour carries its own `resolved_neighbours` (built to
    /// [`MAX_PORTAL_HOPS`]) so the `find_cell_list` loop floods transit cells
    /// across several portals, GATED by the sphere-vs-cell intersection test
    /// (acclient.c:348337 / 355502) so only reachable cells enter the ring.
    fn find_transit_cells(
        &self,
        _p: &Position,
        num_sphere: u32,
        spheres: &[Sphere],
        cell_array: &mut dyn CellArrayApi,
        _path: Option<&mut SpherePath>,
    ) {
        // `CEnvCell::find_transit_cells` (acclient.c:348250) floods the portal
        // ring, but only the neighbours the moving spheres actually reach:
        // `CCellStruct::sphere_intersects_cell` (acclient.c:355502 →
        // `BSPNODE::sphere_intersects_cell_bsp` 362980, radius+0.01 pad) is the
        // spatial bound that keeps the flood from cascading through every portal
        // (gmriggs/trevis). `CellArray::add_cell` dedups by id, and the
        // `find_cell_list` loop re-reads `num_cells`, so each emitted neighbour is
        // visited in turn → multi-hop transit (a neighbour carries its OWN
        // `resolved_neighbours`, bounded by `MAX_PORTAL_HOPS` at build time).
        for (id, handle, membership) in &self.resolved_neighbours {
            // Gate: a moving sphere (WORLD space — `SpherePath::global_sphere`)
            // must intersect the neighbour's cell-membership BSP after being
            // transformed into the neighbour's local frame. No membership resident
            // ⇒ add ungated (the E2 depth-1 behaviour — bridge tests/static cells).
            let reaches = match membership {
                Some(m) => spheres.iter().take(num_sphere as usize).any(|s| {
                    let local = m.world_to_local(s.center);
                    m.tree.sphere_intersects_cell(&local, s.radius) != CellBound::Outside
                }),
                None => true,
            };
            if reaches {
                cell_array.add_cell(*id, Some(handle.clone()));
            }
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
        if self.terrain_polys.is_some() {
            // OUTDOOR `CLandCell::FindEnvCollisions` (terrain polygon path —
            // distinct from the indoor env BSP). Phase D / WS3.
            let env = self.find_terrain_collisions(transition);
            if env != TransitionState::OK as i32 {
                return env;
            }
        } else if let Some(bsp) = self.bsp.as_ref() {
            // INDOOR `CEnvCell::FindEnvCollisions`: SPHEREPATH::cache_localspace_
            // sphere(&this->pos, scale) — the resolver's localspace_* input — then
            // BSPTREE::find_collisions over the cell-local environment tree.
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
        // Object/static collisions (Phase C). Dynamic ENTITIES are not tested
        // in-cell here: the cell adapter has no `TransitionEnv`/scene handle, so
        // the faithful driver collides only cell env-BSP + baked cell statics.
        // Dynamic-entity collision for the live faithful path is marshalled ONE
        // level up, in `finish_manual_slice_via_transition` (movement/system.rs)
        // under `USE_FAITHFUL_ENTITY_COLLISION` (default-OFF, FU-3 2026-07-20):
        // it clamps the realized lateral residual via `entity_colliders_near` +
        // `clamp_delta_against_entities` after this driver resolves geometry.
        // (The legacy `open_door_exclusion_aabbs`/exclusion-AABB path is a
        // separate, legacy-only mechanism and does not run here.)
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
        // Phase E3.4: the static pass uses the STATIC's own scale — retail
        // `CPhysicsPart::find_obj_collisions` caches into the part's frame with
        // the PART's `gfxobj_scale.z` (acclient.c:314669), NOT the mover's scale
        // (the mover's size already lives in the sphere radius). Unscaled
        // env-cell statics are 1.0; scaled outdoor scenery carries its own.
        for st in &self.statics {
            // The static's WORLD frame (origin + orientation basis) — the part
            // pose `CPhysicsPart::find_obj_collisions` caches into (acclient.c:314669).
            let st_pos = Position {
                objcell_id: self.cell_id,
                frame: frame_from(st.orientation, st.origin),
            };
            transition
                .sphere_path
                .cache_localspace_sphere(&st_pos, st.scale);
            let r = holtburger_dat::transition::resolver_find::find_collisions(
                &st.tree,
                transition,
                st.scale,
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
        self.build_cell_inner(cell_id, MAX_PORTAL_HOPS)
    }

    /// `hops`: how many further portal levels to resolve. The primary/visible cell
    /// is built with [`MAX_PORTAL_HOPS`]; each portal neighbour is resolved at
    /// `hops - 1`, so a neighbour built with `hops > 0` carries its OWN
    /// `resolved_neighbours` and the `find_cell_list` loop (which re-reads
    /// `num_cells`) floods transit cells across several portals — bounded, because
    /// at `hops == 0` neighbours are leaves (empty `resolved_neighbours`) and the
    /// per-cell sphere gate in `find_transit_cells` prunes unreached cells. A
    /// neighbour that is not resident resolves to `None` and is dropped (graceful
    /// stale-handle handling). The build can revisit a cell across branches; that
    /// is cheap at `MAX_PORTAL_HOPS == 2` and harmless (handles are independent
    /// clones, the flood dedups by id).
    fn build_cell_inner(&self, cell_id: u32, hops: u32) -> Option<Rc<dyn CObjCell>> {
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
        // `CCellPortal::GetOtherCell` → `CEnvCell::GetVisible` (acclient.c:362341)
        // per neighbour, depth-bounded by `hops`. Each neighbour carries its OWN
        // world frame (non-Euclidean-safe) AND its cell-membership BSP, which
        // `find_transit_cells` uses to gate the flood (sphere-vs-cell). Resolving
        // neighbours at `hops - 1` lets the flood reach multi-hop transit cells.
        let resolved_neighbours: Vec<(u32, ObjCellHandle, Option<CellMembership>)> = if hops > 0 {
            portal_neighbours
                .iter()
                .filter_map(|&nb| {
                    self.build_cell_inner(nb, hops - 1)
                        .map(|h| (nb, h, self.scene.cell_membership(nb).cloned()))
                })
                .collect()
        } else {
            Vec::new()
        };
        let cell = SceneObjCell {
            cell_id,
            pos,
            bsp,
            statics,
            aabb,
            portal_neighbours,
            resolved_neighbours,
            // E3.2: precise membership BSP for this cell (falls back to AABB if absent).
            membership: self.scene.cell_membership(cell_id).cloned(),
            // Indoor env cell — no terrain triangles (mutually exclusive with bsp).
            terrain_polys: None,
            landblock_origin: Vector3::zero(),
            // E3.6: indoor cells are never water.
            water_type: WaterType::NotWater,
            corner_is_water: [false; 4],
        };
        Some(Rc::new(cell) as Rc<dyn CObjCell>)
    }
}

impl CellWorld for SceneWorld<'_> {
    /// `CObjCell::GetVisible` (acclient.c:346417) — split on the cell id: interior
    /// env cells (`id & 0xFFFF >= 0x100`) build through [`Self::build_cell`]
    /// (`CEnvCell::GetVisible`); outdoor land cells route to the `Landscape`
    /// seam (`CLandCell::Get` / [`SpatialScene::get_landcell`], WS1), so the
    /// driver's `insert_into_cell(check_cell)` collides the player's CURRENT
    /// outdoor cell against its terrain (Phase D / WS3). Cached either way.
    fn get_visible(&self, cell_id: u32) -> Option<ObjCellHandle> {
        if let Some(cached) = self.cache.borrow().get(&cell_id) {
            return cached.clone();
        }
        let built = if (cell_id & 0xFFFF) >= 0x100 {
            self.build_cell(cell_id)
        } else {
            self.scene.get_landcell(cell_id)
        };
        self.cache.borrow_mut().insert(cell_id, built.clone());
        built
    }

    /// `CLandCell::add_all_outside_cells` (acclient.c:355346) — the outdoor
    /// terrain ring. Forwards to the ported [`add_all_outside_cells_sphere`]
    /// using the scene as both the `Landscape` (`get_landcell`) and `LandDefsSeam`
    /// (`adjust_to_outside`) seams (WS1). Phase D / WS3. The driver always owns
    /// `self.cell_array` (a concrete [`CellArray`]) and passes it as `&mut dyn
    /// CellArrayApi`, so the downcast is infallible; a foreign `CellArrayApi`
    /// (none exists in production) would no-op. Only invoked for OUTDOOR root
    /// cells (`find_cell_list`'s `< 0x100` branch).
    ///
    /// FRAME: the ported ring/`adjust_to_outside` math is ACE's — it expects the
    /// sphere centre as BLOCK-LOCAL coords (`floor(local/24)` is the in-block cell
    /// index). The bridge runs the driver in WORLD space, so we localize each
    /// sphere centre (and `p`'s frame origin) by this landblock's world origin
    /// before the ring selection. The cells returned are GLOBAL lcoords (correct
    /// full cell ids), and `find_cell_list`'s separate `point_in_cell` reseat /
    /// the cell handles keep using WORLD coords against the world-space cell AABBs.
    fn add_all_outside_cells(
        &self,
        p: &Position,
        num_sphere: u32,
        spheres: &[Sphere],
        cell_array: &mut dyn CellArrayApi,
    ) {
        let Some(ca) = cell_array.as_any_mut().downcast_mut::<CellArray>() else {
            return;
        };
        // WORLD → block-local (relative to p's landblock) for the ACE ring math.
        let lb_origin = landblock_world_origin(p.objcell_id);
        let mut p_local = *p;
        p_local.frame.origin = p_local.frame.origin - lb_origin;
        let spheres_local: Vec<Sphere> = spheres
            .iter()
            .take(num_sphere as usize)
            .map(|s| Sphere {
                center: s.center - lb_origin,
                radius: s.radius,
            })
            .collect();
        add_all_outside_cells_sphere(ca, self.scene, self.scene, &p_local, num_sphere, &spheres_local);
    }

    fn block_offset(&self, base_cell: u32, other_cell: u32) -> Vector3 {
        LandDefs::get_block_offset(base_cell, other_cell)
    }
}

// ─── Landscape + LandDefsSeam for SpatialScene (Phase D / WS1) ────────────────
//
// The two seams the already-ported outdoor cell-ring machinery
// (`objcell.rs::add_all_outside_cells_sphere` / `add_outside_cell` /
// `check_add_cell_boundary`) consumes but was never fed: `LandDefsSeam`
// (`adjust_to_outside` — snap a sphere centre into the landblock that contains
// it) and `Landscape` (`get_landcell` — the outdoor cell registry). Ported from
// ACE `Physics/Common/LandDefs.cs` (REFERENCE ONLY; physics math, no
// gameplay/DB), cross-checked against the decomp's `LandDefs::adjust_to_outside`
// (acclient.c:467434) and `LScape::get_landcell`. WS4 wires `SceneWorld::add_all_
// outside_cells` to `add_all_outside_cells_sphere(.., scene, scene, ..)` using
// these (the scene is both `Landscape` AND `LandDefsSeam`).

/// `LandDefs::BlockLength` (ACE `LandDefs.cs:102`) — 8 cells × 24 units.
const BLOCK_LENGTH: f32 = 192.0;
/// `LandDefs::LandLength` (ACE `LandDefs.cs:104`) — 255 landblocks × 8 cells.
const LAND_LENGTH_I: i32 = 2040;
/// `PhysicsGlobals::EPSILON` (ACE `PhysicsGlobals.cs:9`). The pre-snap that
/// `AdjustToOutside` applies so a near-zero in-block coord lands cleanly on a
/// cell edge instead of one ULP into the previous cell.
const ADJUST_EPSILON: f32 = 0.0002;
/// Vertical pad for the outdoor cell's `point_in_cell` AABB band (WS1). A loose
/// bound around the cell's terrain-corner Z range — the same role as the indoor
/// cell AABB (see [`SceneObjCell::aabb`]). VERIFY(WS3): the terrain
/// `ResolvedPolygon`s + a precise membership test replace this band once the
/// outdoor `find_collisions` geometry lands.
const OUTDOOR_AABB_Z_PAD: f32 = 64.0;

/// `LandDefs::cell_in_range` (ACE `LandDefs.cs:220`): is the IN-BLOCK cell id
/// (`cell_id & 0xFFFF`) a wrappable land / structure / env cell?
/// (`0xFFFF`, `1..=64`, or `0x100..=0xFFFD`.)
fn cell_in_range(cell_id_low: u32) -> bool {
    cell_id_low == 0xFFFF
        || (1..=64).contains(&cell_id_low)
        || (0x100..=0xFFFD).contains(&cell_id_low)
}

/// `LandDefs::blockid_to_lcoord` (ACE `LandDefs.cs:169`): the landblock's
/// bottom-left corner GLOBAL lcoord `(blockX*8, blockY*8)`. `None` out of range.
fn blockid_to_lcoord(cell_id: u32) -> Option<(i32, i32)> {
    // x = ((cellID >> 16 & 0xFF00) >> 8) << 3  == ((cellID >> 24) & 0xFF) * 8
    // y =  (cellID >> 16 & 0x00FF)        << 3 == ((cellID >> 16) & 0xFF) * 8
    let x = ((((cell_id >> 16) & 0xFF00) >> 8) << 3) as i32;
    let y = (((cell_id >> 16) & 0x00FF) << 3) as i32;
    if x < 0 || y < 0 || x >= LAND_LENGTH_I || y >= LAND_LENGTH_I {
        None
    } else {
        Some((x, y))
    }
}

/// `LandDefs::get_outside_lcoord` (ACE `LandDefs.cs:200`): the GLOBAL landcell
/// `(x, y)` containing the block-local point `(_x, _y)` within `block_cell_id`'s
/// landblock. `floor(_x / 24)` is the in-block cell index (`<0` / `>=8` when the
/// point spilled into an adjacent landblock — handled by the bounds gate).
fn get_outside_lcoord(block_cell_id: u32, _x: f32, _y: f32) -> Option<(i32, i32)> {
    if !cell_in_range(block_cell_id & 0xFFFF) {
        return None;
    }
    let (ox, oy) = blockid_to_lcoord(block_cell_id)?;
    let x = ox + (_x / CELL_SIZE).floor() as i32;
    let y = oy + (_y / CELL_SIZE).floor() as i32;
    if x < 0 || y < 0 || x >= LAND_LENGTH_I || y >= LAND_LENGTH_I {
        None
    } else {
        Some((x, y))
    }
}

impl LandDefsSeam for SpatialScene {
    /// `LandDefs::adjust_to_outside` (ACE `LandDefs.cs:125`, decomp
    /// acclient.c:467434). Snap the point into the outdoor landblock that
    /// actually contains it: returns the wrapped outdoor cell id and rewrites
    /// `loc` to block-local `[0,192)` coords. `None` when `cell_id` isn't a
    /// wrappable cell or the point lands out of the world grid (ACE's `return
    /// false` / `blockCellID = 0` branch — the caller `add_all_outside_cells_sphere`
    /// breaks on `None`).
    fn adjust_to_outside(&self, cell_id: u32, loc: &mut Vector3) -> Option<u32> {
        if !cell_in_range(cell_id & 0xFFFF) {
            return None;
        }
        // Pre-snap near-zero in-block coords (ACE LandDefs.cs:131-134).
        if loc.x.abs() < ADJUST_EPSILON {
            loc.x = 0.0;
        }
        if loc.y.abs() < ADJUST_EPSILON {
            loc.y = 0.0;
        }
        let (x, y) = get_outside_lcoord(cell_id, loc.x, loc.y)?;
        let out_id = lcoord_to_cellid(x, y);
        // Rewrite loc to the NEW landblock's block-local frame [0,192)
        // (ACE LandDefs.cs:140-141).
        loc.x -= (loc.x / BLOCK_LENGTH).floor() * BLOCK_LENGTH;
        loc.y -= (loc.y / BLOCK_LENGTH).floor() * BLOCK_LENGTH;
        Some(out_id)
    }
}

impl Landscape for SpatialScene {
    /// `CLandCell::Get` → `LScape::get_landcell`: the outdoor land cell for
    /// `cell_id`, or `None` when that landblock isn't resident. `gid_to_lcoord`
    /// rejects interior ids (low u16 ≥ 0x100) and out-of-range landblocks
    /// (LScape only ever resolves OUTDOOR `CLandCell`s); residency keys on
    /// loaded terrain heights. On `None` the ring still adds a null entry
    /// (faithful — `add_outside_cell`, objcell.rs:553).
    fn get_landcell(&self, cell_id: u32) -> Option<ObjCellHandle> {
        let (gx, gy) = gid_to_lcoord(cell_id)?;
        if !self.terrain_landblock_resident(cell_id) {
            return None;
        }
        Some(build_outdoor_cell(self, cell_id, gx, gy))
    }
}

/// The WORLD-space origin of `cell_id`'s landblock: `(blockX·192, blockY·192, 0)`
/// where `blockX = (cell_id>>24)&0xFF`, `blockY = (cell_id>>16)&0xFF`. Terrain
/// triangles are landblock-local; this rebases between that frame and WORLD.
fn landblock_world_origin(cell_id: u32) -> Vector3 {
    let block_x = ((cell_id >> 24) & 0xFF) as f32;
    let block_y = ((cell_id >> 16) & 0xFF) as f32;
    Vector3::new(block_x * BLOCK_LENGTH, block_y * BLOCK_LENGTH, 0.0)
}

/// Build an OUTDOOR land cell handle (Phase D / WS1) — the outdoor twin of
/// [`SceneWorld::build_cell`]. Carries NO env BSP (terrain is its own polygon
/// path, built in WS2/WS3), the cell's resident statics from
/// [`SpatialScene::cell_static_physics_bsp`] (the Option C overlap index, WS7),
/// and a 24×24 world-footprint AABB whose Z band spans the cell's four terrain
/// corners (padded) so `find_cell_list`'s `point_in_cell` re-seat works.
/// `gx`/`gy` are the GLOBAL landcell coords (already fold in the landblock
/// offset).
/// `CLandBlockStruct::CalcCellWater` (acclient.c:353608) — classify a 24 m cell's
/// water type from its 4 corner terrain-type codes. A corner is water iff its
/// code is one of the five retail water terrain types `16..=20`
/// (`WaterRunning`/`WaterStandingFresh`/`WaterShallowSea`/`WaterShallowStillSea`/
/// `WaterDeepSea` — the `TERRAIN_SURF_CHAR == WATER` band, acclient.c:41303; ACE
/// `SurfChar` agrees). All four corners ⇒ EntirelyWater; any ⇒ PartiallyWater;
/// none ⇒ NotWater. Returns the per-corner flags for the wading-depth lookup.
///
/// NOTE: the legacy heightfield path's `WorldState::is_water_terrain_code` also
/// counts codes 22/23 — but retail `TERRAIN_SURF_CHAR[22/23]` and ACE `SurfChar`
/// both mark those SOLID, so the faithful path uses only `16..=20`.
fn classify_cell_water(corner_codes: [u8; 4]) -> (WaterType, [bool; 4]) {
    let is_water = |c: u8| matches!(c & 0x1f, 16..=20);
    let flags = [
        is_water(corner_codes[0]),
        is_water(corner_codes[1]),
        is_water(corner_codes[2]),
        is_water(corner_codes[3]),
    ];
    let n = flags.iter().filter(|&&w| w).count();
    let water_type = match n {
        0 => WaterType::NotWater,
        4 => WaterType::EntirelyWater,
        _ => WaterType::PartiallyWater,
    };
    (water_type, flags)
}

fn build_outdoor_cell(scene: &SpatialScene, cell_id: u32, gx: i32, gy: i32) -> ObjCellHandle {
    let statics = scene.cell_static_physics_bsp(cell_id).to_vec();

    // World XY footprint: [gx*24, gx*24+24] × [gy*24, gy*24+24].
    let x0 = gx as f32 * CELL_SIZE;
    let y0 = gy as f32 * CELL_SIZE;

    // In-block cell index (`gx/gy mod 8`) + the landblock's WORLD origin
    // (`(blockX·192, blockY·192)`; blockX = gx>>3). `x0 == landblock_origin.x +
    // cell_x*24` by construction, so the terrain polys (landblock-local) frame
    // back to this cell's world footprint.
    let cell_x = (gx & 7) as u32;
    let cell_y = (gy & 7) as u32;
    let landblock_origin = landblock_world_origin(cell_id);

    // The two collision triangles (WS2) + the Z band from the four corner
    // heights (`vx*9+vy` layout). Defaults to a flat band at 0 / no terrain when
    // (impossibly, given the residency gate above) the grid is absent.
    let (mut zmin, mut zmax) = (0.0f32, 0.0f32);
    let mut terrain_polys: Option<[ResolvedPolygon; 2]> = None;
    if let Some(grid) = scene.terrain_cell_heights(cell_id) {
        let cx = cell_x as usize;
        let cy = cell_y as usize;
        let corners = [
            grid[cx * 9 + cy],
            grid[(cx + 1) * 9 + cy],
            grid[cx * 9 + cy + 1],
            grid[(cx + 1) * 9 + cy + 1],
        ];
        zmin = corners.iter().copied().fold(f32::INFINITY, f32::min);
        zmax = corners.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        terrain_polys = Some(cell_terrain_polys(grid, cell_id & 0xFFFF_0000, cell_x, cell_y));
    }
    let aabb = Aabb::new(
        Vector3::new(x0, y0, zmin - OUTDOOR_AABB_Z_PAD),
        Vector3::new(
            x0 + CELL_SIZE,
            y0 + CELL_SIZE,
            zmax + OUTDOOR_AABB_Z_PAD,
        ),
    );

    let pos = Position {
        objcell_id: cell_id,
        // The outdoor cell's terrain polys carry their own landblock-local frame
        // (rebased via `landblock_origin`); `pos` is unused on the terrain path.
        // Identity is correct (statics carry their own world frame).
        frame: Frame::identity(),
    };

    // E3.6: classify this cell's water type from its 4 corner terrain codes (the
    // SAME corner indices as the height corners above). No resident codes (or a
    // non-water cell) ⇒ NotWater — fail-soft, identical to today's behaviour.
    let (water_type, corner_is_water) = match scene.terrain_cell_water_codes(cell_id) {
        Some(codes) => {
            let cx = cell_x as usize;
            let cy = cell_y as usize;
            classify_cell_water([
                codes[cx * 9 + cy],
                codes[(cx + 1) * 9 + cy],
                codes[cx * 9 + cy + 1],
                codes[(cx + 1) * 9 + cy + 1],
            ])
        }
        None => (WaterType::NotWater, [false; 4]),
    };

    Rc::new(SceneObjCell {
        cell_id,
        pos,
        bsp: None,
        statics,
        aabb: Some(aabb),
        portal_neighbours: Vec::new(),
        resolved_neighbours: Vec::new(),
        // Outdoor land cells have no CellStruct.cell_bsp → AABB/terrain membership.
        membership: None,
        terrain_polys,
        landblock_origin,
        water_type,
        corner_is_water,
    }) as ObjCellHandle
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
/// Routing:
///   * OUTDOOR (Phase D / WS4): when `faithful_outdoor` is on AND the begin
///     landblock's terrain is resident, the pose runs the faithful terrain
///     driver (outdoor cell ring via [`SceneWorld::add_all_outside_cells`] +
///     the outdoor [`SceneObjCell`] terrain path). Otherwise — `faithful_outdoor
///     == false` (`?faithfulOutdoor=off`) OR the landblock's terrain not yet
///     loaded (the unbaked-landblock guard, parallel to the indoor no-BSP guard)
///     — it delegates to the existing heightfield pipeline
///     ([`find_transitional_position`]).
///   * INDOOR: a pose whose cell has no physics BSP delegates (the academy-
///     rubberband pre-bake guard); otherwise the local player's env-cell
///     collision routes through the faithful driver.
///
/// Phase 3 Phase E1 / WS-D: `faithful_stepup` (`USE_FAITHFUL_STEPUP` /
/// `?stepUp=off`) is stamped onto `CTransition::faithful_stepup` and read by the
/// WS-B (indoor BSP) + WS-C (terrain) step-up climb seams. Default-ON; `=off`
/// rolls climbing back to the pre-E1 stop-at-base behavior.
/// USE_RETAIL_GROUND — the faithful terrain normal under a world pose, using the
/// SAME `cell_terrain_polys` + `find_terrain_poly` the driver's terrain path runs
/// (so it agrees exactly with the collision plane, not the legacy heightfield
/// sampler). `None` off resident terrain (indoor cells / non-loaded landblocks).
/// Drives the walkable-vs-steep discriminator (`begin_on_walkable`) for the lip
/// edge-protection: a mover on WALKABLE terrain is held at a lip (T4); one on a
/// too-steep face keeps `cliff_slide` and slides (T2).
fn faithful_terrain_normal(scene: &SpatialScene, pose: &WorldPosition) -> Option<Vector3> {
    let cell_id = scene.current_cell(pose);
    let heights = scene.terrain_cell_heights(cell_id)?;
    let (lb_x, lb_y) = pose.landblock_coords();
    let g = pose.global_coords();
    let local = Vector3::new(
        g.x - lb_x as f32 * METERS_PER_LANDBLOCK,
        g.y - lb_y as f32 * METERS_PER_LANDBLOCK,
        g.z,
    );
    let cell_x = (local.x / CELL_SIZE).floor().clamp(0.0, 7.0) as u32;
    let cell_y = (local.y / CELL_SIZE).floor().clamp(0.0, 7.0) as u32;
    let polys = cell_terrain_polys(heights, cell_id & 0xFFFF_0000, cell_x, cell_y);
    find_terrain_poly(&polys, local).map(|p| p.plane.normal)
}

pub fn faithful_find_transitional_position(
    env: &dyn TransitionEnv,
    input: &TransitionInput,
    faithful_outdoor: bool,
    faithful_stepup: bool,
) -> TransitionOutcome {
    let scene = env.scene();
    let begin_cell = scene.current_cell(&input.begin);
    let outdoor = !input.begin.is_indoors();

    if outdoor {
        // OUTDOOR (Phase D / WS4). Run the faithful terrain driver only when the
        // outdoor flag is ON (WS9) AND the begin landblock's terrain is resident.
        // The residency guard is the outdoor twin of the indoor no-BSP guard:
        // `get_landcell` returns `None` for a non-resident landblock, so the ring
        // would flood NULL cells and `insert_into_cell` would find no terrain to
        // collide — the mover would free-fall. In both off-cases delegate to the
        // heightfield pipeline (the `?faithfulOutdoor=off` rollback + pre-load
        // fallback). `find_cell_list` then routes `begin_cell` (low word < 0x100)
        // through the outdoor ring/land-cell path inside the driver.
        if !faithful_outdoor || !scene.terrain_landblock_resident(begin_cell) {
            return find_transitional_position(env, input);
        }
    } else {
        // INDOOR. No physics BSP for the begin cell → nothing for the faithful env
        // path to test. Fall back to the existing pipeline (pre-bake guard parity).
        if scene.cell_physics_bsp(begin_cell).is_none() {
            return find_transitional_position(env, input);
        }
    }

    let end_cell = scene.current_cell(&input.end);

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
    // Phase 3 Phase E1 / WS-D: thread the `USE_FAITHFUL_STEPUP` / `?stepUp=off`
    // toggle into the driver. `CTransition::new()` defaults this ON; this honors
    // the runtime `?stepUp=off` rollback. Read by the WS-B/WS-C climb seams.
    t.faithful_stepup = faithful_stepup;
    // USE_RETAIL_GROUND — thread the gate into the driver so `edge_slide`'s
    // outdoor lip edge-protection (driver_spine.rs) engages only under the port,
    // plus the walkable-vs-steep discriminator: whether the mover BEGAN on walkable
    // terrain (only then does a run-off get HELD; a mid-slope slider keeps sliding).
    t.retail_ground = input.gates.retail_ground;
    if input.gates.retail_ground {
        t.begin_on_walkable = faithful_terrain_normal(scene, &input.begin)
            .is_some_and(|n| n.z >= 0.664_174_1);
    }
    // Phase 3 Phase E1b / WS-C (2026-06-29) — restore the faithful persistent
    // `ON_WALKABLE` precondition for a GROUNDED mover (the genuine vertical-lip
    // step-up fix). Retail's OBJECTINFO carries `ON_WALKABLE` across frames —
    // recomputed each `validate_transition` from the walkable contact plane
    // (driver_validate.rs:185-194) — so a mover standing on walkable ground enters
    // the next transition already `ON_WALKABLE`. holtburger rebuilds OBJECTINFO
    // fresh every frame from `input.object.state`, which `for_local_player` stamps
    // CONTACT|EDGE_SLIDE only (no `ON_WALKABLE`), so the persistent grounded latch
    // is dropped and `CTransition::step_up` falls back to the 0.04 default
    // step-down budget (driver_spine.rs:418) instead of `step_up_height`
    // (driver_spine.rs:420-423) — `step_sphere_down` then descends 0.04, never
    // reaches a curb/stair top, and the mover sticks at `face − radius`. When a
    // grounded mover (`!airborne`, or `force_grounded`) enters the slice, stamp
    // `ON_WALKABLE` so `step_up` gets the `step_up_height` budget and the EXISTING
    // `step_sphere_down` → `CPolygon::adjust_sphere_to_plane` chain lifts the
    // sphere onto a lip shorter than `step_up_height` (taller stays out of reach —
    // the emergent height gate, NO hand-coded threshold). `validate_transition`
    // recomputes the bit each step from the real contact plane, so a non-walkable
    // entry support (cliff/steep face) self-corrects (no float-up). Gated by
    // `faithful_stepup` (`?stepUp=off` ⇒ no stamp ⇒ the pre-E1 stuck-at-base A/B).
    //
    // INDOOR (env-cell BSP) ONLY: the vertical-lip step-up is the BSP chain
    // (`step_sphere_up` → `step_down` → `step_sphere_down` →
    // `CPolygon::adjust_sphere_to_plane`) that ONLY the indoor/static narrow-phase
    // runs. The OUTDOOR terrain path is the separate Phase-D `find_terrain_collisions`
    // → `OBJECTINFO::validate_walkable` chain (a height-field, NO vertical lips),
    // and forcing `ON_WALKABLE` there REGRESSES the cliff stop: `validate_walkable`
    // only pushes a mover out of WALKABLE surfaces when `ON_WALKABLE` is set
    // (objectinfo.rs:163-181, `if step_down || !ON_WALKABLE || valid`), and the
    // faithful cliff stop relies on the per-substep `ON_WALKABLE`-clear oscillation
    // that a fresh-per-frame entry stamp defeats (→ walk-through). Outdoor
    // slope-climb / cliff-stop already work via that chain (Phase D) and are
    // unaffected here.
    let grounded_entry = !input.airborne || input.force_grounded;
    // 2026-06-30 — extend the persistent `ON_WALKABLE` grounded-latch to OUTDOOR
    // poses standing on a resident static/building surface. A building ROOF is
    // outdoor space (`is_indoors() == false`) but is collided by the SAME
    // static-BSP narrow-phase as indoor cells (`find_obj_collisions` over
    // `cell_static_physics_bsp`, populated by the 0x01/0x02 building-BSP staging),
    // so it needs the same entry latch to ground via the `step_sphere_down` chain.
    // Without it the roof is collided (walls block) but the mover never latches
    // grounded → gravity slides it off + the pose reverts. Gated on a resident
    // static BSP in the begin cell so the pure-terrain outdoor path (heightfield
    // cliff-stop, which `ON_WALKABLE` would regress — see the block above) is
    // unaffected. Carrier: `gates.outdoor_static_grounding` (`?roofGrounding=off`).
    let on_outdoor_static = input.gates.outdoor_static_grounding
        && outdoor
        && !scene.cell_static_physics_bsp(begin_cell).is_empty();
    if t.faithful_stepup && grounded_entry && (input.begin.is_indoors() || on_outdoor_static) {
        t.object_info.state |= object_info_state::ON_WALKABLE;
    }
    // USE_RETAIL_GROUND (2026-07-02, `?retailGround=off`) — the retail
    // outdoor ground-movement port. Empirically the block above's premise
    // ("outdoor slope-climb / cliff-stop already work via the per-substep
    // chain") does NOT hold on the live path: without the entry latch,
    // `validate_walkable`'s `!ON_WALKABLE` short-circuit (objectinfo.rs:145/
    // :164) records + pushes the mover out of ANY penetrated terrain plane
    // regardless of steepness — a cliff face behaves like a floor you climb —
    // and without `object_info.step_down` the entire step-down snap +
    // `edge_slide` decision tree (transitional_insert, acclient.c:312961-
    // 313009) is unreachable, so there is no downhill stick, no FLOOR_Z
    // slope refusal, no cliff_slide and no lip protection. Retail:
    //   * `OBJECTINFO::init` (acclient.c:314131): `step_down = !(state &
    //     Missile)` — always TRUE for the player;
    //   * `CPhysicsObj::get_object_info` (acclient.c:319074-319099): a
    //     grounded mover enters the transition CONTACT|ON_WALKABLE (from
    //     `transient_state` 0x1/0x2) with its stored contact plane seeded
    //     via `init_contact_plane`; an airborne mover carries NEITHER bit
    //     (our `for_local_player` stamps CONTACT unconditionally — strip it
    //     when airborne so landing runs the permissive Z_FOR_LANDING arm);
    //   * the seeded plane feeds `adjust_offset`'s slope projection
    //     (downhill offset follows the surface — the feet-planted fix) and
    //     `cliff_slide`'s `cross(N, lastKnownN)` skid direction.
    // `validate_transition` recomputes CONTACT/ON_WALKABLE from the real
    // contact plane every step (driver_validate.rs:185-195), so a steep
    // support self-corrects — the stamp is the retail carry, not a cheat.
    //
    // USE_RETAIL_GROUND edge-hold: the WALKABLE support the mover entered on —
    // its carried contact plane, iff WALKABLE (`N.z >= FloorZ`). `Some` ⇒ it stood
    // on walkable ground last frame; drives the walkable-lip re-plant in the
    // grounded marshalling below. A mid-slope slider (T2) carries a too-steep plane
    // ⇒ `None` ⇒ EXCLUDED (it keeps sliding). Derived from the NORMAL only (not the
    // seed's `near` test), because the terrain contact plane's `d` is landblock-
    // local (find_terrain_collisions rebases into the LB frame) while the seed's
    // low point is world — so `near` never fires outdoors, but the normal is
    // frame-independent (LB↔world is a pure translation).
    let entry_walkable_contact: Option<(holtburger_common::Plane, u32)> = input
        .last_contact_plane
        .filter(|(p, _)| p.normal.z >= 0.664_174_1);
    if input.gates.retail_ground {
        t.object_info.step_down = true;
        // Entry contact/walkable bits from the STORED plane — the faithful
        // mapping of retail's `transient_state` carry + `check_contact`
        // (acclient.c:319074-319099 / :316536; ACE PhysicsObj.cs:2586/2217):
        //   * CONTACT ⇔ the mover's last transition ended with a contact
        //     plane (our exact-clearing `last_contact_plane` store), the
        //     plane is still LOCAL to the begin pose (retail clears contact
        //     state on teleports; the nearness guard covers our one-frame
        //     store lag), and the mover is not moving AWAY from it. Retail's
        //     `check_contact` tests `m_velocityVector · N > EPSILON` — on
        //     ground retail locomotion is animation-driven (near-zero physics
        //     velocity), so the test effectively fires only for the
        //     jump/launch v_z. Our integrator keeps that same split
        //     (planar store + `vertical_velocity`), so the faithful proxy is
        //     the vertical arc: ascending (`!descending`) over an up-facing
        //     plane = moving away (the retail jump bypass, `CMotionInterp::
        //     jump` → `set_on_walkable(0)`, acclient.c:344247).
        //   * ON_WALKABLE ⇔ CONTACT && the stored plane is WALKABLE
        //     (`N.z >= FloorZ`, retail `SetPositionInternal`
        //     acclient.c:322598-322604). A too-steep support therefore
        //     enters CONTACT-only: gravity stays on, `adjust_offset`
        //     projects the step along the face (the retail cliff slide),
        //     and the FLOOR_Z gate in `validate_walkable` refuses to treat
        //     the face as a floor — no more free cliff climbing.
        let mut live_contact = false;
        if let Some((plane, cell_id)) = input.last_contact_plane {
            let feet = input.begin.global_coords();
            let low_center = Vector3::new(feet.x, feet.y, feet.z + radius);
            let bottom_dist = plane.normal.dot(&low_center) + plane.d - radius;
            let near = bottom_dist.abs() <= input.object.step_down_height.max(radius);
            // Retail `check_contact` (acclient.c:316536): contact is dropped
            // when the mover moves AWAY from the plane (`velocity·N > EPS`).
            // Retail ground locomotion is animation-driven (near-zero physics
            // velocity), so the test effectively fires on the jump/launch
            // v_z — our faithful proxy is the vertical arc (`!descending`).
            let moving_away = !input.descending && plane.normal.z > 0.0;
            if near && !moving_away {
                t.object_info.state |= object_info_state::CONTACT;
                t.init_contact_plane(cell_id, plane, false);
                live_contact = true;
            } else if near {
                t.init_last_known_contact_plane(cell_id, plane, false);
            }
        }
        if grounded_entry {
            // The persistent grounded latch (retail carries CONTACT|ON_WALKABLE
            // from `transient_state`, acclient.c:319090-319096). Kept for every
            // walkable-latched entry — CONTACT arms the step-down snap (the
            // retail downhill stick) and ON_WALKABLE keys the FLOOR_Z slope
            // gate + `edge_slide`'s lip machine. A stale/echoed latch cannot
            // stick the mover mid-air: `grounded` below derives from the
            // transition's FINAL contact plane, not from these entry bits.
            t.object_info.state |=
                object_info_state::CONTACT | object_info_state::ON_WALKABLE;
        } else if !live_contact {
            // Airborne with no live contact: retail enters with NEITHER bit
            // (the permissive Z_FOR_LANDING landing arm). Airborne WITH a live
            // contact (sliding on a too-steep face) keeps CONTACT but not
            // ON_WALKABLE: gravity stays on and `adjust_offset` projects the
            // step along the face — the retail slide-down.
            t.object_info.state &= !object_info_state::CONTACT;
        }
    }
    t.init_sphere(2, &spheres, 1.0);
    t.init_path(Some(begin_cell), Some(&begin_pos), &end_pos);
    // Retail stationary-fall carry SEED — `CPhysicsObj::transition` seeds the
    // fresh CTransition's counter from the persistent `transient_state` bits
    // 0x10/0x20/0x40 (acclient.c:320104-320115). Without this cross-frame
    // carry the counter re-enters 0 every frame, `validate_transition`'s
    // resting-floor synthesis (fires at 2, acclient.c:312283-312311) can never
    // be reached, and a falling mover whose every slice ends COLLIDED-with-
    // contact-cleared (the grocer-seam riser wedge: collide → find_walkable
    // adjust → Placement re-insert intersects the step solid → full clear +
    // restore, acclient.c:312897-312941) stays frozen airborne forever.
    t.collision_info.frames_stationary_fall = input.frames_stationary_fall;

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
    let mut pose = WorldPosition {
        landblock_id: input.begin.landblock_id,
        coords: Vector3::new(
            curr.frame.origin.x - lb_origin_x,
            curr.frame.origin.y - lb_origin_y,
            curr.frame.origin.z,
        ),
        rotation: input.end.rotation,
    };
    // OUTDOOR (Phase D / WS4): the faithful sweep can cross a 192 m landblock
    // boundary, so the begin-relative block-local coords can leave `[0,192)`.
    // Re-bucket into the correct landblock and re-derive the outdoor cell word —
    // the per-step rebucket the heightfield path applies (transition.rs:803).
    // No-op for indoor (single-landblock dungeons) and for in-block walks.
    if outdoor {
        pose = pose.rebucket_outdoor_landblock().normalize_outdoor_cell();
    }

    // Cell-transit flip (walk-in fix, 2026-07-02): retail re-derives cell
    // membership from geometry every transition in BOTH directions
    // (`check_building_transit` acclient.c:348110 / `find_cell_list`
    // acclient.c:313300). The legacy chain (system.rs:3070) and the
    // approximate pipeline (`step_cell_transit_flips`, transition.rs:369)
    // both carry this flip, but this bridge — the default path since
    // `USE_FAITHFUL_TRANSITION` went on (Phase 3 B4, 2026-06-28) — pinned
    // the output `landblock_id` to `input.begin`'s, so a player WALKING
    // into a building never flipped indoors: `is_indoors()` stayed false,
    // the indoor render/collision branches never engaged, and interiors
    // stayed hidden while standing inside the shell. Same gate + capsule
    // radius as the sibling paths (entry/exit MUST move together).
    if input.gates.local_envcell_entry {
        if !pose.is_indoors() {
            if let Some(entered) =
                scene.entered_envcell_for_outdoor_pose(&pose, input.object.radius)
            {
                pose.landblock_id = holtburger_common::Guid(entered);
            }
        } else if let Some(outdoor_cell) =
            scene.exited_envcell_to_outdoor(&pose, input.object.radius)
        {
            pose.landblock_id = holtburger_common::Guid(outdoor_cell);
        } else {
            // Indoor→indoor cell transit (2026-07-18): the settled pose above
            // is pinned to `input.begin`'s cell, and neither the outdoor
            // rebucket (outdoor-only) nor the entry/exit flips touch a walk
            // BETWEEN EnvCells of the same dungeon — so the pose's low word
            // froze at the login cell while x/y streamed (live: 0x01AD across
            // 60m of soak wandering). Re-derive from geometry like retail's
            // per-transition `find_cell_list`; `current_cell` falls back to
            // the unchanged id when no loaded AABB contains the point.
            pose.landblock_id = holtburger_common::Guid(scene.current_cell(&pose));
        }
    }

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
    //
    // USE_RETAIL_GROUND (2026-07-02): the retail derivation instead — retail
    // `SetPositionInternal` recomputes on-walkable EVERY frame from the
    // transition's FINAL contact plane (`contact_plane_valid` +
    // `N.z >= floor_z ? set_on_walkable(1) : set_on_walkable(0)`,
    // acclient.c:322586-322615) and a contact-less frame LEAVES GROUND. The
    // bit-based mapping above echoes the ENTRY stamp through zero-offset
    // transitions (`num_steps == 0` never runs `validate_transition`), which
    // let a mover stand planted mid-air / on a too-steep face forever.
    let grounded = if input.gates.retail_ground {
        const RETAIL_FLOOR_Z: f32 = 0.664_174_1; // PhysicsGlobals::floor_z
        match t.collision_info.contact_plane {
            Some(plane) => plane.normal.z >= RETAIL_FLOOR_Z,
            None => t.sphere_path.walkable.is_some(),
        }
    } else {
        (t.object_info.state & object_info_state::ON_WALKABLE) != 0
            || t.sphere_path.walkable.is_some()
    };
    // USE_RETAIL_GROUND walkable-lip edge-hold (2026-07-02). A grounded mover
    // CANNOT walk off a walkable edge — retail edge protection holds it (only a
    // jump clears OnWalkable → T5). `edge_slide` blocks the POSITION at the lip
    // (driver_spine.rs edge-protect) and sets `t.edge_held`, but the step-down
    // snap that grazed the too-steep face below clears the contact AND `last_known`
    // (the collide path, acclient.c:312897-312935), so `validate_transition`'s
    // BRANCH-A contact restore (acclient.c:312223-312254) has nothing to re-seat:
    // the frame ends contact-less ⇒ `grounded == false` ⇒ the caller `begin_fall`s
    // a planted mover into a free fall off the lip (the T4 bug). Re-plant it on the
    // DRIVER's `edge_held` latch — set ONLY inside the `ON_WALKABLE && EDGE_SLIDE`
    // gate, which a mid-slope slider (T2) never enters (too-steep support clears
    // `ON_WALKABLE`), so T2 keeps sliding. The `entry_walkable_contact` carry keeps
    // the walkable plane for the next frame's seed; the no-drop test is a belt-and-
    // braces guard (a genuine descent still falls). Position already held by the
    // driver — this only restores the grounded latch.
    let (grounded, edge_hold_plane) = if input.gates.retail_ground
        && !grounded
        && t.edge_held
        && entry_walkable_contact.is_some()
        && curr.frame.origin.z >= input.begin.global_coords().z - radius
    {
        (true, entry_walkable_contact)
    } else {
        (grounded, None)
    };
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
    // portal-spanning sweep is VERIFY(1070) (needs the live cell graph). The
    // walk-in flip above also counts: it rebinds the pose's cell even when the
    // driver's sweep stayed in `begin_cell`.
    let cell_changed =
        curr.objcell_id != begin_cell || pose.landblock_id != input.begin.landblock_id;
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

    // USE_RETAIL_GROUND — surface the settled contact plane for the caller's
    // cross-frame carry: retail `SetPositionInternal` copies the transition's
    // CONTACT plane + its validity onto the object (acclient.c:322538-322590)
    // — NOT the last-known plane. The distinction is load-bearing: the
    // `edge_slide` cliff branch CLEARS the contact plane (acclient.c:312712-
    // 312717), so a face-skid frame ends contact-INVALID and the next frame
    // seeds nothing — `adjust_offset` then cannot re-project the walk input
    // up the face it was just refused from (the climb-ratchet this fixes).
    // On a walkable-lip edge-hold the driver ended contact-less (the collide
    // path cleared it); carry the ENTRY walkable plane forward so the next
    // frame re-seeds CONTACT and the mover keeps its footing at the lip.
    let contact_plane = edge_hold_plane.or_else(|| {
        t.collision_info
            .contact_plane
            .map(|plane| (plane, t.collision_info.contact_plane_cell_id))
    });

    TransitionOutcome {
        pose,
        wall_normal,
        grounded,
        cell_changed,
        state,
        contact_plane,
        // Retail read-back: the post-transition counter the caller persists /
        // acts on (`CPhysicsObj::report_collision_end`, acclient.c:321862-321918).
        frames_stationary_fall: t.collision_info.frames_stationary_fall,
    }
}

// ─── Arrival placement (retail SetPosition path) ─────────────────────────────

/// Result of the retail placement search on an authoritative arrival — the
/// de-embedded pose plus the settled contact state the caller writes back.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacementOutcome {
    /// The adjusted (de-embedded / step-down-settled) feet pose, landblock-local
    /// coords with the low-word cell re-derived from geometry.
    pub pose: WorldPosition,
    /// `true` ⇔ the transition ended on a walkable contact plane
    /// (`contact_plane.N.z >= FloorZ`), the retail `SetPositionInternal`
    /// on-walkable derivation (acclient.c:322586-322604).
    pub grounded: bool,
    /// The settled contact plane (+ its cell id) for the caller's
    /// `last_contact_plane` carry — retail `CPhysicsObj::contact_plane`.
    pub contact_plane: Option<(holtburger_common::Plane, u32)>,
    /// WORLD-space distance the placement search moved the mover, measured
    /// arrival-world → settled-world (FU-11). This is the TRUE de-embed magnitude
    /// (~0.9 m at the grocer vestibule); the caller logs it. Deriving it from
    /// `pose.global_coords()` vs `outcome.pose.global_coords()` would instead
    /// report the ~120 m cell-local→landblock-local FRAME correction, since the
    /// arrival pose is cell-local while the output pose is landblock-local.
    pub adjusted_by: f32,
}

/// Retail placement transition on an authoritative arrival — the missing wiring
/// for `CPhysicsObj::SetPosition`'s placement path (`find_placement_position`,
/// `acclient.c:313341` → `find_placement_pos`, `acclient.c:313015`).
///
/// When a teleport / force-blip lands the capsule EMBEDDED in an env-cell wall,
/// the swept-step transitional driver refuses every subsequent move (each
/// substep collides → `validate_transition` BRANCH-A resets `check_pos`→`curr`,
/// no contact plane ever establishes). Retail avoids this by running a PLACEMENT
/// transition on arrival: `find_placement_pos`'s radial search (radius up to
/// 4.0/2.0, angular sweep) ADJUSTS an embedded start to the nearest valid pose,
/// then `step_down` (walkable-allowance `Z_FOR_LANDING`) settles ground contact.
///
/// Construction mirrors [`faithful_find_transitional_position`]: begin cell via
/// `scene.current_cell`, the indoor BSP-residency guard (`None` ⇒ the cell is
/// not resident yet — the caller keeps the latch and retries), the vertical
/// two-sphere capsule, and the `retail_ground` object setup (`step_down = true`).
/// The insert type is the PLACEMENT variant: `init_path(cell, None, &pos)` seeds
/// `curr` from the end pose and stamps `insert_type = Placement`
/// (`SPHEREPATH::init_path`, `acclient.c:314043`), exactly the retail
/// `init_path(transit, cell, 0, pos)` call (`acclient.c:319175`);
/// `find_placement_position` then manages the InitialPlacement→Placement
/// transitions internally. `placement_allows_sliding` defaults `true` from
/// `CTransition::new()` (retail clears it only when the SetPosition flags forbid
/// sliding — a teleport allows it, `acclient.c:319178`).
///
/// Returns `None` when the begin cell's BSP is not resident (retry later) OR the
/// placement search finds no valid pose (`found == 0`); otherwise the settled
/// pose + grounded + contact plane, marshalled the same way the transitional fn
/// does.
pub fn faithful_find_placement_position(
    env: &dyn TransitionEnv,
    pose: &WorldPosition,
    object: &super::transition::ObjectInfo,
    gates: &super::transition::TransitionGates,
) -> Option<PlacementOutcome> {
    let scene = env.scene();
    let begin_cell = scene.current_cell(pose);

    // INDOOR residency guard (the transitional fn's no-BSP guard): a begin cell
    // with no resident physics BSP has nothing to place against — return None so
    // the caller keeps the latch and retries once the cell streams in.
    if scene.cell_physics_bsp(begin_cell).is_none() {
        return None;
    }

    // WORLD-space frame; begin == end == the arrival pose (a placement, not a
    // sweep). Identity player rotation → vertical two-sphere capsule.
    //
    // FRAME CONTRACT (FU-11, 2026-07-20). The INDOOR arrival pose is CELL-LOCAL:
    // the live server (ACE) writes an indoor `Position`'s coords RELATIVE to the
    // EnvCell's own placement frame (cell-local), and the wire → `WorldPosition`
    // unpack stores them verbatim (`traits.rs`, no cell→landblock conversion). A
    // teleport / force-blip is the ONLY thing that latches this placement
    // (`consume_pending_arrival_placement`, system.rs → `latch_arrival_placement`
    // on `Reset`/`ForceBlip`/`PlayerTeleport`), and that arrival pose is exactly
    // the server-authored cell-local frame — distinct from a WALK-IN (which
    // enters via the transitional `local_envcell_entry` seam already carrying
    // landblock-local coords, and does NOT latch placement).
    //
    // The scene's cell physics BSP carries that SAME placement frame: `origin` in
    // WORLD space (`landblock origin + EnvCell.position.origin`) and `orientation`
    // the cell quaternion (lib.rs `fetchEnvCellsInLandblock` / the env840 harness
    // `build_scene`). Lift the cell-local coords into WORLD through it —
    //     world = cell_origin + cell_orientation · cell_local
    // — the exact inverse of the `CellPhysicsBsp::world_to_local` the collision
    // resolver applies. `global_coords()` (landblock origin + coords, z
    // passthrough) is WRONG for a cell-local pose: it starts the search ~90 m
    // below the floor (z 0.35 vs floor ~94) and tens of metres off in XY — the
    // pre-FU-11 `[arrival-placement] placement search failed` live warn (found==0,
    // no geometry inside the ≤4 m radial sweep). The OUTPUT marshalling below
    // re-derives LANDBLOCK-local coords (world − landblock origin), NORMALIZING
    // the arrival into the one frame every downstream consumer already assumes
    // (walk transitional `global_coords`, JS `rustPoseWorldFromPose`, cell-AABB
    // `current_cell`).
    //
    // Outdoor arrivals never reach here (the caller returns early for outdoor, and
    // an outdoor cell has no env BSP so the residency guard above already returned
    // None); the `global_coords` fallback is retained defensively.
    let arrival_world = if pose.is_indoors() {
        match scene.cell_physics_bsp(begin_cell) {
            Some(bsp) => bsp.origin + bsp.orientation.rotate_vector(pose.coords),
            None => pose.global_coords(),
        }
    } else {
        pose.global_coords()
    };
    let mut frame = Frame::identity();
    frame.origin = arrival_world;
    let pos = Position {
        objcell_id: begin_cell,
        frame,
    };

    let radius = object.radius;
    let height = object.height;
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
    // A freshly-teleported mover enters placement with contact state CLEARED —
    // retail `get_object_info` (acclient.c:319074) seeds CONTACT/ON_WALKABLE
    // from `transient_state`, which a teleport zeroes, so the placement
    // transition starts contact-less and the initial insert + step_down settle
    // re-establish ground. Keep EDGE_SLIDE (from `AllowsEdgeSlide`).
    t.object_info.state =
        object.state & !(object_info_state::CONTACT | object_info_state::ON_WALKABLE);
    t.object_info.step_up_height = object.step_up_height;
    t.object_info.step_down_height = object.step_down_height;
    t.object_info.ethereal = object.ethereal;
    // The climb seams read `faithful_stepup`; placement runs the same step_down
    // chain the transitional fn does, so keep it ON.
    t.faithful_stepup = true;
    t.retail_ground = gates.retail_ground;
    if gates.retail_ground {
        // OBJECTINFO::init (acclient.c:314131): `step_down = !(state & Missile)` —
        // always true for the player; arms `find_placement_position`'s step_down
        // settle (driver_validate.rs:285-326).
        t.object_info.step_down = true;
    }
    t.init_sphere(2, &spheres, 1.0);
    // init_path with a NULL begin_pos ⇒ seed `curr` from `end` and stamp
    // `insert_type = Placement` (driver_init.rs:212-218); `find_valid_position`
    // then dispatches to `find_placement_position` (driver_validate.rs:233).
    t.init_path(Some(begin_cell), None, &pos);

    let world = SceneWorld::new(scene);
    let mover = FaithfulMover { has_gravity: true };
    let found = t.find_valid_position(&world, &mover);
    if found == 0 {
        return None;
    }

    // ── Marshal CTransition → PlacementOutcome ── (same single-landblock indoor
    // rebucket as the transitional fn: the settled world origin round-trips
    // through begin's landblock origin; re-derive the low-word cell from
    // geometry so a placement that crossed an EnvCell seam reports the new cell).
    let curr = t.sphere_path.curr_pos;
    let (lb_x, lb_y) = pose.landblock_coords();
    let lb_origin_x = lb_x as f32 * METERS_PER_LANDBLOCK;
    let lb_origin_y = lb_y as f32 * METERS_PER_LANDBLOCK;
    let mut out_pose = WorldPosition {
        landblock_id: pose.landblock_id,
        coords: Vector3::new(
            curr.frame.origin.x - lb_origin_x,
            curr.frame.origin.y - lb_origin_y,
            curr.frame.origin.z,
        ),
        rotation: pose.rotation,
    };
    // Indoor→indoor cell re-derivation (mirrors the transitional fn's
    // `find_cell_list` flip, faithful_bridge.rs:1263) so the low word tracks the
    // cell the adjusted pose actually landed in.
    if gates.local_envcell_entry && out_pose.is_indoors() {
        out_pose.landblock_id = holtburger_common::Guid(scene.current_cell(&out_pose));
    }

    // grounded / contact plane ← retail `SetPositionInternal` (acclient.c:322586-
    // 322604): CONTACT ⇔ the transition ended contact-valid; ON_WALKABLE ⇔
    // `N.z >= FloorZ`. No walkable-latch fallback here — retail placement reads
    // the contact plane only.
    const RETAIL_FLOOR_Z: f32 = 0.664_174_1; // PhysicsGlobals::floor_z
    let contact_plane = t
        .collision_info
        .contact_plane
        .map(|plane| (plane, t.collision_info.contact_plane_cell_id));
    let grounded = t
        .collision_info
        .contact_plane
        .is_some_and(|plane| plane.normal.z >= RETAIL_FLOOR_Z);

    // FU-11: the TRUE de-embed magnitude, measured in a single WORLD frame
    // (arrival_world → settled curr.frame.origin), not across the cell-local→
    // landblock-local frame change the output pose encodes.
    let adjusted_by = (curr.frame.origin - arrival_world).length();

    Some(PlacementOutcome {
        pose: out_pose,
        grounded,
        contact_plane,
        adjusted_by,
    })
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
    use super::{
        classify_cell_water, faithful_find_transitional_position, FaithfulMover, SceneWorld,
        WaterType,
    };
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
            outdoor_static_grounding: false,
            retail_ground: false,
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
            last_contact_plane: None,
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
            scale: 1.0,
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

    // ── Phase E1 / WS-B: indoor walkable up-slope (RAMP) + a too-tall riser ──
    //
    // RAMP_RUN/RISE define a 1:2 up-slope (cell-local): rise 2 over run 4 ⇒ plane
    // normal (-0.447, 0, 0.894). normal.z 0.894 > FLOOR_Z (0.664) ⇒ WALKABLE, and
    // the normal faces −x (toward the approaching +x mover). The riser height
    // RISER_TALL (2.0) is ≫ the player step_up_height (0.6) ⇒ a too-tall riser
    // that must NOT climb (proves the step_up_height gate).
    const RAMP_RUN: f32 = 4.0;
    const RAMP_RISE: f32 = 2.0;
    const RISER_TALL: f32 = 2.0;

    /// A cell-local sloped quad rising +z along +x from `(x0,0)` to `(x1,rise)`,
    /// y∈[−HE,HE]. Winding gives a +z, −x-facing normal (front-faces a +x mover).
    fn ramp_poly_local(x0: f32, x1: f32, z0: f32, z1: f32) -> ResolvedPolygon {
        poly(vec![
            v(x0, -HE, z0),
            v(x1, -HE, z1),
            v(x1, HE, z1),
            v(x0, HE, z0),
        ])
    }

    /// Indoor scene: flat floor for x<0 (z=0), a RAMP for x∈[0,run] rising to
    /// z=rise, then a flat top floor for x>run (z=rise). World z = FLOOR_WZ +
    /// local-z (cell origin z = FLOOR_WZ). A gentle `run:rise` (e.g. 4:2 ⇒
    /// normal.z 0.894 > FLOOR_Z) is WALKABLE; a steep one (e.g. 2:4 ⇒ normal.z
    /// 0.447 < FLOOR_Z) is a non-walkable CLIFF the mover must not climb.
    fn ramp_env_slope(run: f32, rise: f32) -> DriftEnv {
        let o = cell_origin();
        let mut polys = HashMap::new();
        polys.insert(1u16, floor_poly_local(-HE, 0.0, 0.0)); // base flat
        polys.insert(2u16, ramp_poly_local(0.0, run, 0.0, rise)); // up-slope
        polys.insert(3u16, floor_poly_local(run, HE, rise)); // top flat
        let mut scene = SpatialScene::new();
        scene.insert_cell_physics_bsp(CELL_ID, bsp_from(polys));
        // World triangles for the approximate path (base + sloped + top).
        let mut tris = floor_tris_world(o.x - HE, o.x, o.y - HE, o.y + HE, FLOOR_WZ);
        tris.push(Triangle::new(
            v(o.x, o.y - HE, FLOOR_WZ),
            v(o.x + run, o.y - HE, FLOOR_WZ + rise),
            v(o.x + run, o.y + HE, FLOOR_WZ + rise),
        ));
        tris.push(Triangle::new(
            v(o.x, o.y - HE, FLOOR_WZ),
            v(o.x + run, o.y + HE, FLOOR_WZ + rise),
            v(o.x, o.y + HE, FLOOR_WZ),
        ));
        tris.extend(floor_tris_world(
            o.x + run,
            o.x + HE,
            o.y - HE,
            o.y + HE,
            FLOOR_WZ + rise,
        ));
        seed_common(&mut scene, tris);
        DriftEnv { scene }
    }

    /// The default WALKABLE ramp (1:2 ⇒ normal.z 0.894).
    fn ramp_env() -> DriftEnv {
        ramp_env_slope(RAMP_RUN, RAMP_RISE)
    }

    /// Indoor scene: flat floor for x<0 (z=0), a VERTICAL riser at x=0 of height
    /// `riser`, then a flat top floor for x>0 at z=riser. The riser is a
    /// −x-facing wall (N.z=0). `riser < step_up_height` ⇒ climbable; `riser ≫
    /// step_up_height` ⇒ the too-tall gate.
    fn step_env(riser: f32) -> DriftEnv {
        let o = cell_origin();
        let mut polys = HashMap::new();
        polys.insert(1u16, floor_poly_local(-HE, 0.0, 0.0)); // base flat
        polys.insert(
            2u16,
            poly(vec![
                v(0.0, -HE, 0.0),
                v(0.0, -HE, riser),
                v(0.0, HE, riser),
                v(0.0, HE, 0.0),
            ]),
        ); // vertical riser, N=−x
        polys.insert(3u16, floor_poly_local(0.0, HE, riser)); // top flat
        let mut scene = SpatialScene::new();
        scene.insert_cell_physics_bsp(CELL_ID, bsp_from(polys));
        let mut tris = floor_tris_world(o.x - HE, o.x, o.y - HE, o.y + HE, FLOOR_WZ);
        tris.push(Triangle::new(
            v(o.x, o.y - HE, FLOOR_WZ),
            v(o.x, o.y - HE, FLOOR_WZ + riser),
            v(o.x, o.y + HE, FLOOR_WZ + riser),
        ));
        tris.push(Triangle::new(
            v(o.x, o.y - HE, FLOOR_WZ),
            v(o.x, o.y + HE, FLOOR_WZ + riser),
            v(o.x, o.y + HE, FLOOR_WZ),
        ));
        tris.extend(floor_tris_world(
            o.x,
            o.x + HE,
            o.y - HE,
            o.y + HE,
            FLOOR_WZ + riser,
        ));
        seed_common(&mut scene, tris);
        DriftEnv { scene }
    }

    // ── Phase E1b / WS-B: faithful indoor walkable slope climb + cliff/riser stop ──
    //
    // WS-B reverted E1 v1's `driver_validate.rs` up-offset early-stop RELAXATION
    // (the `faithful_stepup && CONTACT` bypass) — the recon refuted it as a live
    // NO-OP, so the verbatim decomp early-stop (313269-313274) is restored. A
    // grounded mover still CLIMBS a walkable up-slope under the LIVE horizontal
    // input model — that climb is a side-effect of the swept-sphere collision
    // resolution (`step_sphere_up` → `step_up` → `step_down`, gated on the
    // walkable-Z threshold), NOT the validate gate — and STOPS at a steep cliff /
    // too-tall riser. The genuine vertical-lip step-up (lifting onto a curb / stair
    // shorter than step_up_height via the emergent `step_sphere_down` /
    // `adjust_sphere_to_plane` chain) is the WS-C fix (the `ON_WALKABLE`
    // precondition); the `?stepUp` flag now gates THAT, not this gate. The tests
    // below assert the flag-independent slope climb and the cliff/riser stop.

    /// Drive `frames` movement frames up `env`: each frame steps +`dx` in x toward
    /// `surface_wz(x)` minus a gravity `SINK` (the live movement-controller cadence),
    /// threading the previous settled pose forward and the `faithful_stepup` flag.
    /// Returns every settled pose (start first) for monotonic / jitter assertions.
    fn frame_walk(
        env: &DriftEnv,
        start: WorldPosition,
        dx: f32,
        surface_wz: impl Fn(f32) -> f32,
        frames: usize,
        stepup_on: bool,
    ) -> Vec<WorldPosition> {
        let mut pose = start;
        let mut trail = vec![pose];
        for _ in 0..frames {
            let nx = pose.coords.x + dx;
            let end = pose_at(nx, pose.coords.y, surface_wz(nx) - SINK);
            let out =
                faithful_find_transitional_position(env, &input_for(pose, end), true, stepup_on);
            pose = out.pose;
            trail.push(pose);
        }
        trail
    }

    // THRESHOLD: a steep CLIFF (2:4 slope ⇒ normal.z 0.447 < FLOOR_Z) is NOT
    // walkable, and a too-tall VERTICAL riser (≫ step_up_height) has no reachable
    // walkable top. Walked into HORIZONTALLY (the live `desired_world_delta` model
    // — forward + gravity, never a pre-computed uphill destination), the mover
    // STOPS at the base and does NOT climb, with the `?stepUp` flag ON or OFF (the
    // flag no longer touches this gate). A flat-floor control proves the geometry
    // — not a stuck driver — is what stops the climb.
    #[test]
    fn stepup_steep_cliff_and_tall_riser_do_not_climb() {
        // Horizontal forward + gravity sink (the live input model). The destination
        // never points uphill, so the climb only happens if the swept sphere
        // discovers a WALKABLE up-surface under it — which neither the cliff nor the
        // wall provides.
        let horiz = |lx: f32| -> f32 {
            let _ = lx;
            FLOOR_WZ
        };
        let start = pose_at(FCX - 1.0, FCY, FLOOR_WZ);

        for &on in &[true, false] {
            // Steep cliff (2:4 ⇒ normal.z 0.447 < FLOOR_Z 0.664).
            let cliff = ramp_env_slope(2.0, 4.0);
            let c_end = *frame_walk(&cliff, start, 0.3, horiz, 60, on).last().unwrap();
            assert!(
                c_end.coords.z < FLOOR_WZ + 0.5,
                "steep cliff must NOT be climbed (on={on}): z {}",
                c_end.coords.z
            );

            // Too-tall vertical riser (2 m ≫ step_up_height 0.6).
            let tall = step_env(RISER_TALL);
            let t_end = *frame_walk(&tall, start, 0.3, horiz, 60, on).last().unwrap();
            assert!(
                t_end.coords.z < FLOOR_WZ + 0.5,
                "too-tall riser must NOT be climbed (on={on}): z {}",
                t_end.coords.z
            );
        }
    }

    // ── Phase E1b / WS-C/WS-D HEADLINE: the vertical-LIP step-up A/B ──────────
    //
    // A grounded mover walks HORIZONTALLY (forward + gravity SINK, the live input
    // model — NO pre-aimed uphill destination) into a VERTICAL curb shorter than
    // `step_up_height` (0.6). With `?stepUp` ON (default) the WS-C `ON_WALKABLE`
    // precondition gives `CTransition::step_up` the `step_up_height` step-down
    // budget, so the EMERGENT `step_sphere_down` → `CPolygon::adjust_sphere_to_plane`
    // chain lifts the sphere onto the curb top (feet-z rises ~+curb) — NO invented
    // raise, NO hand-coded threshold. With `?stepUp=off` the precondition is not
    // restored, `step_up` falls back to the 0.04 default budget, `step_sphere_down`
    // never reaches the top, and the mover STICKS at the riser base (`face − radius`)
    // — the genuine A/B (both feet-z printed). A taller-than-`step_up_height` curb
    // (1.0 m) STOPS under BOTH ON and OFF: the emergent geometric reach / interp
    // window can't admit it (the faithful "too tall ⇒ stop", no threshold).
    #[test]
    fn stepup_short_curb_climbs_on_stuck_off() {
        const CURB: f32 = 0.3; // < step_up_height (0.6) ⇒ climbable
        // The EXACT live grounded model (movement/system.rs): dz = raw_delta.z =
        // target_velocity.z*dt = 0 for a grounded walk (gravity applies ONLY when
        // airborne), so each frame the END pose is the begin advanced +dx in x at
        // the SAME z — NO pre-aimed uphill destination, NO artificial sink. The
        // lift, if any, is the faithful `step_sphere_up`/`adjust_sphere_to_plane`
        // chain (the same cadence `stepup_live_horizontal_walk_climbs_walkable_slope`
        // drives). `step_env`'s riser sits at cell-local x=0 ⇒ landblock-local FCX.
        fn live_walk(env: &DriftEnv, start: WorldPosition, frames: usize, on: bool) -> Vec<WorldPosition> {
            let mut pose = start;
            let mut trail = vec![pose];
            for _ in 0..frames {
                let end = pose_at(pose.coords.x + 0.3, pose.coords.y, pose.coords.z);
                pose = faithful_find_transitional_position(env, &input_for(pose, end), true, on).pose;
                trail.push(pose);
            }
            trail
        }
        // Start on the flat base, one metre before the riser at local x=0.
        let start = pose_at(FCX - 1.0, FCY, FLOOR_WZ);
        let curb = step_env(CURB);

        let on_trail = live_walk(&curb, start, 40, true);
        let off_trail = live_walk(&curb, start, 40, false);
        let on_end = *on_trail.last().unwrap();
        let off_end = *off_trail.last().unwrap();
        eprintln!(
            "[curb-{CURB}] base_wz={:.3} top_wz={:.3} riser_local_x=0 | ON feet=({:.3},{:.3}) OFF feet=({:.3},{:.3})",
            FLOOR_WZ, FLOOR_WZ + CURB, on_end.coords.x, on_end.coords.z, off_end.coords.x, off_end.coords.z
        );

        // ON: climbs onto the curb top — feet-z rises ~+CURB onto the walkable top,
        // and advances past the riser (local x = 0 ⇒ FCX in world-local terms).
        assert!(
            on_end.coords.z > FLOOR_WZ + CURB - 0.1,
            "stepUp ON: mover must CLIMB onto the {CURB} curb top {} (feet-z rises): got z {}",
            FLOOR_WZ + CURB, on_end.coords.z
        );
        assert!(
            on_end.coords.x > FCX + 0.1,
            "stepUp ON: mover must advance past the riser (local x>0): got x {}",
            on_end.coords.x
        );

        // OFF: stuck at the base — feet-z stays at the floor (no climb), the mover
        // does not mount the curb top.
        assert!(
            off_end.coords.z < FLOOR_WZ + 0.1,
            "stepUp OFF: mover must STICK at the base {} (no climb): got z {}",
            FLOOR_WZ, off_end.coords.z
        );
        // The genuine A/B: ON climbs strictly higher than OFF (the flag is real).
        assert!(
            on_end.coords.z > off_end.coords.z + (CURB - 0.1),
            "curb A/B: ON ({}) must climb the curb, OFF ({}) must stay at base",
            on_end.coords.z, off_end.coords.z
        );

        // NO jitter: feet-z is monotonic non-decreasing on the ON climb (a clean
        // settle onto the top, no oscillation at the lip), and x never backsteps.
        for w in on_trail.windows(2) {
            assert!(
                w[1].coords.z >= w[0].coords.z - 1e-3,
                "curb climb jitter: feet-z went backwards {} -> {}",
                w[0].coords.z, w[1].coords.z
            );
            assert!(
                w[1].coords.x >= w[0].coords.x - 1e-3,
                "curb climb jitter: x went backwards {} -> {}",
                w[0].coords.x, w[1].coords.x
            );
        }
        // Settled exactly ON the top (not floating above it): within ~one radius.
        assert!(
            (on_end.coords.z - (FLOOR_WZ + CURB)).abs() < radius(),
            "ON settle is ON the curb top {} (no float): got z {}",
            FLOOR_WZ + CURB, on_end.coords.z
        );
    }

    // The emergent height gate (no hand-coded threshold): a 1.0 m curb (>
    // step_up_height 0.6) STOPS under BOTH ON and OFF — `step_sphere_down` /
    // `adjust_sphere_to_plane` can't reach a top that high, so the mover stays at
    // the base. Brackets the climbable-height feel (0.3 climbs / 1.0 stops).
    #[test]
    fn stepup_tall_curb_stops_both() {
        const CURB: f32 = 1.0; // > step_up_height (0.6) ⇒ out of emergent reach
        // Same faithful dz=0 live grounded cadence as the headline test.
        fn live_walk(env: &DriftEnv, start: WorldPosition, frames: usize, on: bool) -> Vec<WorldPosition> {
            let mut pose = start;
            for _ in 0..frames {
                let end = pose_at(pose.coords.x + 0.3, pose.coords.y, pose.coords.z);
                pose = faithful_find_transitional_position(env, &input_for(pose, end), true, on).pose;
            }
            vec![pose]
        }
        let start = pose_at(FCX - 1.0, FCY, FLOOR_WZ);
        let curb = step_env(CURB);
        for &on in &[true, false] {
            let end = *live_walk(&curb, start, 40, on).last().unwrap();
            eprintln!("[curb-1.0] on={on} feet=({:.3},{:.3})", end.coords.x, end.coords.z);
            assert!(
                end.coords.z < FLOOR_WZ + 0.5,
                "1.0 m curb (> step_up_height) must STOP (on={on}): got z {}",
                end.coords.z
            );
        }
    }

    // ── Phase E1 FAITHFUL HEADLINE PROOF: a grounded mover walking into a
    // walkable up-slope CLIMBS it under the EXACT live input model — and that
    // climb comes from the ported `CSphere::step_sphere_up` (indoor BSP) /
    // `OBJECTINFO::validate_walkable` raise (outdoor terrain), NOT from the WS-B
    // validate-gate relaxation.
    //
    // Unlike the headline climb tests (1)/(2) above — which PRE-AIM the
    // destination at the surface height, producing an upward per-step offset that
    // only the validate early-stop relaxation gates — this drives the *live*
    // grounded model verbatim from `movement/system.rs`:
    //   `end = (pose.x + planar.x*dt, pose.y + planar.y*dt, pose.z + dz)`
    // where `planar.z == 0` and `dz = raw_delta.z = target_velocity.z*dt == 0`
    // for a grounded walk (gravity applies only when `was_airborne`). So the live
    // per-step offset is PURELY HORIZONTAL; retail's `z > 0` up-offset early-stop
    // (decomp 313269-313274) never fires, and the climb is a side-effect of the
    // swept-sphere collision resolution — exactly as retail climbs.
    //
    // CONSEQUENCE (Phase E1b / WS-C update): a WALKABLE slope climbs under BOTH
    // `?stepUp` ON and OFF — the slope poly is itself walkable, so the emergent
    // `find_walkable` → `adjust_sphere_to_plane` raise lands the sphere on it
    // regardless of the `step_up` step-down budget (0.6 when `ON_WALKABLE`, else
    // 0.04 — both reach the gently-penetrated slope). The WS-C `ON_WALKABLE`
    // precondition fix (which the `?stepUp` flag now gates) is the GENUINE
    // vertical-LIP step-up — a curb/stair shorter than `step_up_height`, NOT a
    // continuous slope — so the flag legitimately changes the lip A/B
    // (`stepup_short_curb_climbs_*`) while leaving the slope climb intact. The
    // OUTDOOR slope is the Phase-D `validate_walkable` raise (flag-independent;
    // ON==OFF below). The INDOOR slope climbs both ways but ON advances a hair
    // further (the lip budget), so we assert "both reach the ramp top", not strict
    // byte-identity (the pre-WS-C flag-no-op finding is refuted).
    #[test]
    fn stepup_live_horizontal_walk_climbs_walkable_slope() {
        // The EXACT live grounded model (movement/system.rs): each frame the END
        // pose is the begin pose advanced horizontally by `dx`, with z = pose.z
        // (dz = raw_delta.z = target_velocity.z*dt = 0 for a grounded walk; gravity
        // applies only when airborne). NO pre-aimed uphill destination, NO fixed
        // absolute sink. The climb, if any, must come entirely from the ported
        // `step_sphere_up` (indoor) / `validate_walkable` raise (outdoor).
        fn live_indoor(env: &DriftEnv, start: WorldPosition, frames: usize, on: bool) -> Vec<WorldPosition> {
            let mut pose = start;
            let mut trail = vec![pose];
            for _ in 0..frames {
                let end = pose_at(pose.coords.x + 0.3, pose.coords.y, pose.coords.z);
                pose = faithful_find_transitional_position(env, &input_for(pose, end), true, on).pose;
                trail.push(pose);
            }
            trail
        }
        fn live_outdoor(env: &DriftEnv, start: WorldPosition, frames: usize, on: bool) -> Vec<WorldPosition> {
            let mut pose = start;
            let mut trail = vec![pose];
            for _ in 0..frames {
                let g = pose.global_coords();
                let end = outdoor_pose(g.x + 0.3, g.y, g.z);
                pose = faithful_find_transitional_position(env, &input_for(pose, end), true, on).pose;
                trail.push(pose);
            }
            trail
        }

        // INDOOR walkable ramp (1:2). Start on the flat floor BEFORE the base.
        let renv = ramp_env();
        let rstart = pose_at(FCX - 1.0, FCY, FLOOR_WZ);
        let r_on = live_indoor(&renv, rstart, 120, true);
        let r_off = live_indoor(&renv, rstart, 120, false);
        let ron = r_on.last().unwrap();
        let roff = r_off.last().unwrap();
        eprintln!(
            "[probe-indoor-live] base_wz={:.3} ramp_top_wz={:.3} run_end_x={:.3} | ON end=({:.3},{:.3}) OFF end=({:.3},{:.3})",
            FLOOR_WZ, FLOOR_WZ + RAMP_RISE, FCX + RAMP_RUN, ron.coords.x, ron.coords.z, roff.coords.x, roff.coords.z
        );
        let trace: Vec<String> = r_on.iter().step_by(10)
            .map(|p| format!("({:.2},{:.2})", p.coords.x, p.coords.z)).collect();
        eprintln!("[probe-indoor-live] ON trace x,z: {}", trace.join(" "));

        // OUTDOOR walkable terrain slope (1:2). Start low on the grade.
        let rise = 0.5;
        let oenv = DriftEnv { scene: outdoor_scene(slope_grid(rise)) };
        let (sx, sy) = outdoor_cell_center(1, 4);
        let ostart = outdoor_pose(sx, sy, terrain_wz(sx, rise));
        let osg = ostart.global_coords();
        let o_on = live_outdoor(&oenv, ostart, 80, true);
        let o_off = live_outdoor(&oenv, ostart, 80, false);
        let oon = o_on.last().unwrap().global_coords();
        let ooff = o_off.last().unwrap().global_coords();
        eprintln!(
            "[probe-outdoor-live] start=({:.2},{:.2}) | ON=({:.2},{:.2}) OFF=({:.2},{:.2})",
            osg.x, osg.z, oon.x, oon.z, ooff.x, ooff.z
        );
        let otr: Vec<String> = o_on.iter().step_by(10)
            .map(|p| { let g = p.global_coords(); format!("({:.2},{:.2})", g.x, g.z) }).collect();
        eprintln!("[probe-outdoor-live] ON trace x,z: {}", otr.join(" "));

        // INDOOR: the live walk CLIMBS the full ramp (feet z reaches the top) and
        // advances past the ramp run onto the flat top — the faithful step_sphere_up
        // climb, with NO uphill-aimed offset.
        assert!(
            ron.coords.z > FLOOR_WZ + RAMP_RISE - 0.2,
            "live indoor walk must climb to the ramp top {}: got z {}",
            FLOOR_WZ + RAMP_RISE, ron.coords.z
        );
        assert!(
            ron.coords.x > FCX + RAMP_RUN,
            "live indoor walk must advance past the ramp run: got x {}", ron.coords.x
        );
        // Monotonic climb up the ramp (no jitter): z never drops while on the ramp.
        for w in r_on.windows(2) {
            assert!(w[1].coords.x >= w[0].coords.x - 1e-3, "indoor x backwards (jitter)");
            if w[0].coords.x <= FCX + RAMP_RUN {
                assert!(w[1].coords.z >= w[0].coords.z - 1e-3, "indoor z backwards on ramp (jitter)");
            }
        }
        // OUTDOOR: the live walk CLIMBS the terrain grade, feet tracking the slope.
        assert!(oon.z > osg.z + 6.0, "live outdoor walk must climb the grade: z {} (start {})", oon.z, osg.z);
        assert!(oon.x > osg.x + 12.0, "live outdoor walk must advance up the grade: x {}", oon.x);
        for p in &o_on {
            let g = p.global_coords();
            let want = terrain_wz(g.x, rise);
            assert!((g.z - want).abs() < 0.05, "outdoor feet must track terrain height: z {} want {}", g.z, want);
        }
        // WS-C UPDATE: the INDOOR walkable slope climbs under BOTH ON and OFF
        // (no regression of the E1 slope behavior) — assert OFF also reaches the
        // ramp top and advances past the run, rather than strict ON==OFF byte
        // identity (refuted: the flag now meaningfully gates the vertical-LIP
        // step-up — see `stepup_short_curb_climbs_*`).
        assert!(
            roff.coords.z > FLOOR_WZ + RAMP_RISE - 0.2,
            "stepUp OFF must STILL climb the walkable slope to the top {}: got z {}",
            FLOOR_WZ + RAMP_RISE, roff.coords.z
        );
        assert!(
            roff.coords.x > FCX + RAMP_RUN,
            "stepUp OFF must STILL advance past the ramp run: got x {}", roff.coords.x
        );
        // The OUTDOOR slope is the Phase-D `validate_walkable` raise (a height-field
        // with no vertical lips), which the WS-C indoor-only precondition does not
        // touch — so it stays flag-INDEPENDENT (ON==OFF), the Phase-D regression guard.
        assert_eq!(
            (oon.x, oon.z), (ooff.x, ooff.z),
            "outdoor terrain climb stays flag-independent (WS-C is indoor-BSP only)"
        );
    }

    /// Phase E2 (cross-portal collision): a wall lives in a PORTAL-NEIGHBOUR cell
    /// (`NB_ID`), not the mover's own cell (`CELL_ID`). WITH the portal link the
    /// faithful driver resolves the neighbour (`find_transit_cells` →
    /// `build_cell_inner` → `GetVisible`) and collides the mover against the
    /// neighbour's wall across the portal — it STOPS short. WITHOUT the portal the
    /// neighbour is never flooded into the ring, so it is not collision-tested and
    /// the mover walks THROUGH where the wall is. Same geometry both runs; only the
    /// portal edge differs — proving the portal GRAPH (not spatial overlap) drives
    /// which cells are tested (non-Euclidean-safe; gmriggs/trevis). Before E2 the
    /// neighbour carried a NULL handle and was always skipped → the walk-through.
    #[test]
    fn cross_portal_neighbour_wall_stops_mover() {
        const NB_ID: u32 = 0x1234_0101; // same landblock, neighbour cell
        let o = cell_origin();
        let wall_lx = FCX + WALL_X_LOCAL; // landblock-local x of the wall face (FCX=10 → 11)

        let build = |with_portal: bool| -> DriftEnv {
            let mut scene = SpatialScene::new();
            // CELL_ID: floor only (keeps the mover grounded) + AABB / flat tris.
            let mut floor = HashMap::new();
            floor.insert(1u16, floor_poly_local(-HE, HE, 0.0));
            scene.insert_cell_physics_bsp(CELL_ID, bsp_from(floor));
            seed_common(
                &mut scene,
                floor_tris_world(o.x - HE, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ),
            );
            // NB_ID: the vertical wall (faces −x), framed to world via cell_origin().
            let mut wall = HashMap::new();
            wall.insert(
                1u16,
                poly(vec![
                    v(WALL_X_LOCAL, -HE, 0.0),
                    v(WALL_X_LOCAL, -HE, WALL_H),
                    v(WALL_X_LOCAL, HE, WALL_H),
                    v(WALL_X_LOCAL, HE, 0.0),
                ]),
            );
            scene.insert_cell_physics_bsp(NB_ID, bsp_from(wall));
            if with_portal {
                scene.insert_cell_portal(CELL_ID, NB_ID);
            }
            DriftEnv { scene }
        };

        // Walk +x across frames (the live cadence) on a flat floor so the mover
        // actually reaches the neighbour wall at landblock-local x = wall_lx.
        let flat = |_x: f32| FLOOR_WZ;
        let start = pose_at(FCX, FCY, FLOOR_WZ);
        let xp = frame_walk(&build(true), start, 0.3, flat, 20, true)
            .last()
            .unwrap()
            .coords
            .x;
        let xn = frame_walk(&build(false), start, 0.3, flat, 20, true)
            .last()
            .unwrap()
            .coords
            .x;

        assert!(
            xp < wall_lx - 0.1,
            "cross-portal: mover must STOP before the neighbour wall (wall_lx={wall_lx}, got x={xp})"
        );
        assert!(
            xn > wall_lx + 0.3,
            "no-portal control: mover must WALK THROUGH past the wall (wall_lx={wall_lx}, got x={xn})"
        );
        assert!(
            xn - xp > 1.0,
            "portal stop (x={xp}) must be well short of the no-portal walk-through (x={xn})"
        );
    }

    /// Phase E3.3 (cross-portal MULTI-HOP): the wall lives TWO portals away — in
    /// `FAR_ID`, reachable only through the intermediate `MID_ID`. The flood must
    /// hop CELL_ID → MID_ID → FAR_ID for the wall to be collision-tested. WITH the
    /// second portal edge (`MID_ID → FAR_ID`) the multi-hop build gives MID its own
    /// `resolved_neighbours`, the `find_cell_list` loop visits MID and floods FAR,
    /// and the mover STOPS at the far wall. WITHOUT that edge FAR is never reached
    /// and the mover walks THROUGH. Only the 2nd-hop portal differs — depth-1 (E2
    /// alone) would walk through in BOTH runs, so this is a true multi-hop guard.
    #[test]
    fn cross_portal_multihop_far_wall_stops_mover() {
        const MID_ID: u32 = 0x1234_0101; // 1st hop — passthrough floor
        const FAR_ID: u32 = 0x1234_0102; // 2nd hop — the wall
        let o = cell_origin();
        let wall_lx = FCX + WALL_X_LOCAL; // landblock-local x of the far wall face (11)

        let build = |with_far_portal: bool| -> DriftEnv {
            let mut scene = SpatialScene::new();
            // CELL_ID: floor only (keeps the mover grounded) + AABB / flat tris.
            let mut floor = HashMap::new();
            floor.insert(1u16, floor_poly_local(-HE, HE, 0.0));
            scene.insert_cell_physics_bsp(CELL_ID, bsp_from(floor));
            seed_common(
                &mut scene,
                floor_tris_world(o.x - HE, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ),
            );
            // MID_ID: passthrough floor — resident in BOTH runs so only the 2nd-hop
            // portal edge differs (not MID's residency).
            let mut mid_floor = HashMap::new();
            mid_floor.insert(1u16, floor_poly_local(-HE, HE, 0.0));
            scene.insert_cell_physics_bsp(MID_ID, bsp_from(mid_floor));
            // FAR_ID: the vertical wall (faces −x), framed to world via cell_origin().
            let mut wall = HashMap::new();
            wall.insert(
                1u16,
                poly(vec![
                    v(WALL_X_LOCAL, -HE, 0.0),
                    v(WALL_X_LOCAL, -HE, WALL_H),
                    v(WALL_X_LOCAL, HE, WALL_H),
                    v(WALL_X_LOCAL, HE, 0.0),
                ]),
            );
            scene.insert_cell_physics_bsp(FAR_ID, bsp_from(wall));
            // Chain the portals: CELL → MID always; MID → FAR only in the A run.
            scene.insert_cell_portal(CELL_ID, MID_ID);
            if with_far_portal {
                scene.insert_cell_portal(MID_ID, FAR_ID);
            }
            DriftEnv { scene }
        };

        let flat = |_x: f32| FLOOR_WZ;
        let start = pose_at(FCX, FCY, FLOOR_WZ);
        let xp = frame_walk(&build(true), start, 0.3, flat, 20, true)
            .last()
            .unwrap()
            .coords
            .x;
        let xn = frame_walk(&build(false), start, 0.3, flat, 20, true)
            .last()
            .unwrap()
            .coords
            .x;

        assert!(
            xp < wall_lx - 0.1,
            "multi-hop: mover must STOP before the 2nd-hop wall (wall_lx={wall_lx}, got x={xp})"
        );
        assert!(
            xn > wall_lx + 0.3,
            "no-2nd-portal control: mover must WALK THROUGH past the wall (wall_lx={wall_lx}, got x={xn})"
        );
        assert!(
            xn - xp > 1.0,
            "multi-hop stop (x={xp}) must be well short of the no-portal walk-through (x={xn})"
        );
    }

    /// Phase E3.3 (sphere-vs-cell flood gate): a portal neighbour enters the ring
    /// ONLY when a moving sphere actually reaches it
    /// (`CCellStruct::sphere_intersects_cell`). `WALL_ID` carries the same wall
    /// geometry and portal link in both runs; only its cell-membership BSP differs.
    /// When the membership half-space covers the mover's path the gate PASSES → the
    /// wall is tested → the mover STOPS. When the half-space starts far ahead of the
    /// mover (its spheres never cross the plane) the gate PRUNES the neighbour → it
    /// is never collision-tested → the mover walks THROUGH. Isolates the gate
    /// decision from geometry/portal presence (both identical across the runs).
    #[test]
    fn cross_portal_flood_gate_prunes_unreached_neighbour() {
        use crate::spatial::scene::CellMembership;
        use holtburger_dat::physics::InternalNode;
        const WALL_ID: u32 = 0x1234_0101;
        let o = cell_origin();
        let wall_lx = FCX + WALL_X_LOCAL; // 11

        // Cell-membership half-space {x_local >= plane_x}, origin at the wall cell
        // (identity orientation). The mover's WORLD sphere centres map to cell-local
        // x ≈ 0..6 over the walk, so plane_x = 0 ⇒ reachable, plane_x = 50 ⇒ never.
        let membership = |plane_x: f32| CellMembership {
            tree: BspNode::Internal(InternalNode {
                tag: [0u8; 4],
                plane: Plane {
                    normal: v(1.0, 0.0, 0.0),
                    d: -plane_x,
                },
                pos: Some(Box::new(BspNode::Leaf(BspLeaf {
                    index: 0,
                    solid: 0,
                    sphere: None,
                    poly_ids: vec![],
                }))),
                neg: None,
                sphere: None,
                poly_ids: vec![],
            }),
            origin: o,
            orientation: Quaternion::identity(),
        };

        let build = |plane_x: f32| -> DriftEnv {
            let mut scene = SpatialScene::new();
            let mut floor = HashMap::new();
            floor.insert(1u16, floor_poly_local(-HE, HE, 0.0));
            scene.insert_cell_physics_bsp(CELL_ID, bsp_from(floor));
            seed_common(
                &mut scene,
                floor_tris_world(o.x - HE, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ),
            );
            // WALL_ID: identical wall + portal in both runs; only membership differs.
            // No AABB → never picked as the start cell (`current_cell` scans AABBs),
            // so the membership purely drives the flood gate.
            let mut wall = HashMap::new();
            wall.insert(
                1u16,
                poly(vec![
                    v(WALL_X_LOCAL, -HE, 0.0),
                    v(WALL_X_LOCAL, -HE, WALL_H),
                    v(WALL_X_LOCAL, HE, WALL_H),
                    v(WALL_X_LOCAL, HE, 0.0),
                ]),
            );
            scene.insert_cell_physics_bsp(WALL_ID, bsp_from(wall));
            scene.insert_cell_portal(CELL_ID, WALL_ID);
            scene.insert_cell_membership(WALL_ID, membership(plane_x));
            DriftEnv { scene }
        };

        let flat = |_x: f32| FLOOR_WZ;
        let start = pose_at(FCX, FCY, FLOOR_WZ);
        // plane_x = 0: half-space covers the whole path → gate PASSES.
        let xpass = frame_walk(&build(0.0), start, 0.3, flat, 20, true)
            .last()
            .unwrap()
            .coords
            .x;
        // plane_x = 50: half-space starts ~50 units ahead → spheres always Outside
        // → gate PRUNES the neighbour.
        let xprune = frame_walk(&build(50.0), start, 0.3, flat, 20, true)
            .last()
            .unwrap()
            .coords
            .x;

        assert!(
            xpass < wall_lx - 0.1,
            "gate-pass: reachable neighbour must be flooded and STOP the mover (wall_lx={wall_lx}, got x={xpass})"
        );
        assert!(
            xprune > wall_lx + 0.3,
            "gate-prune: unreachable neighbour must be pruned → mover WALKS THROUGH (wall_lx={wall_lx}, got x={xprune})"
        );
        assert!(
            xprune - xpass > 1.0,
            "gate-pass stop (x={xpass}) must be well short of the gate-prune walk-through (x={xprune})"
        );
    }

    /// Phase E3.2: `point_in_cell` walks the precise cell-membership BSP
    /// (`CCellStruct::point_in_cell`) when resident, NOT the looser AABB. The
    /// membership cell is the positive half-space of the local x=0 plane; a point
    /// on the negative side is OUTSIDE the cell even though the (wide) AABB
    /// contains it — proving the BSP overrides the bounding box.
    #[test]
    fn point_in_cell_uses_membership_bsp_over_aabb() {
        use crate::spatial::scene::CellMembership;
        use holtburger_dat::physics::InternalNode;
        use holtburger_dat::transition::objcell::CellWorld;
        let o = cell_origin();
        let tree = BspNode::Internal(InternalNode {
            tag: [0u8; 4],
            plane: Plane {
                normal: v(1.0, 0.0, 0.0),
                d: 0.0,
            },
            pos: Some(Box::new(BspNode::Leaf(BspLeaf {
                index: 0,
                solid: 0,
                sphere: None,
                poly_ids: vec![],
            }))),
            neg: None,
            sphere: None,
            poly_ids: vec![],
        });
        let mut scene = SpatialScene::new();
        // A wide AABB spanning BOTH sides of the membership plane.
        scene.insert_cell_aabb(
            CELL_ID,
            Aabb::new(
                v(o.x - HE, o.y - HE, o.z - 5.0),
                v(o.x + HE, o.y + HE, o.z + 5.0),
            ),
        );
        scene.insert_cell_membership(
            CELL_ID,
            CellMembership {
                tree,
                origin: o,
                orientation: Quaternion::identity(),
            },
        );
        // Residency: give the cell a physics BSP too (build_cell gate).
        let mut floor = HashMap::new();
        floor.insert(1u16, floor_poly_local(-HE, HE, 0.0));
        scene.insert_cell_physics_bsp(CELL_ID, bsp_from(floor));

        let world = SceneWorld::new(&scene);
        let cell = world.get_visible(CELL_ID).expect("cell resident");
        // Positive side (local x>0): inside the membership cell AND the AABB.
        assert!(
            cell.point_in_cell(v(o.x + 2.0, o.y, o.z)),
            "positive side must be inside the membership cell"
        );
        // Negative side (local x<0): the AABB contains it, but the membership BSP
        // excludes it → point_in_cell must report OUTSIDE (BSP wins over AABB).
        assert!(
            !cell.point_in_cell(v(o.x - 2.0, o.y, o.z)),
            "negative side must be excluded by the membership BSP despite the AABB"
        );
    }

    fn run_ab(env: &DriftEnv, input: &TransitionInput) -> (TransitionOutcome, TransitionOutcome) {
        let approx = find_transitional_position(env, input);
        // Indoor scenes: the outdoor flag is irrelevant (the indoor branch is
        // taken regardless); pass the production default (ON).
        let faithful = faithful_find_transitional_position(env, input, true, true);
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
        // Mirror the bridge's WS-C grounded INDOOR `ON_WALKABLE` stamp (default-ON)
        // so `assert_pose_roundtrips_driver` compares like-for-like driver state.
        if (!input.airborne || input.force_grounded) && input.begin.is_indoors() {
            t.object_info.state |= object_info_state::ON_WALKABLE;
        }
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

    // ── indoor→indoor cell transit (2026-07-18) ──
    // A walk whose settled feet land inside a DIFFERENT EnvCell's AABB must
    // re-derive the pose's low word. Before the marshal-time `current_cell`
    // re-derive, the outcome pose stayed pinned to `input.begin`'s cell for
    // every indoor→indoor move — the v6.2 soak read cell 0x01AD across 60m
    // of dungeon wandering while x/y streamed.
    #[test]
    fn indoor_walk_rederives_envcell_low_word() {
        const NEXT_ID: u32 = 0x1234_0101;
        let o = cell_origin();
        let mut polys = HashMap::new();
        polys.insert(1u16, floor_poly_local(-HE, HE, 0.0));
        let mut scene = SpatialScene::new();
        scene.insert_cell_physics_bsp(CELL_ID, bsp_from(polys));
        // One continuous floor, split between two ADJOINING cell AABBs at
        // x = o.x + 0.5 (no overlap ⇒ the containment scan is deterministic;
        // the faithful slice settles ~0.65m in, past this boundary).
        scene.insert_cell_aabb(
            CELL_ID,
            Aabb::new(
                v(o.x - HE, o.y - HE, FLOOR_WZ - LEDGE_DROP - 0.5),
                v(o.x + 0.5, o.y + HE, FLOOR_WZ + 10.0),
            ),
        );
        scene.insert_cell_aabb(
            NEXT_ID,
            Aabb::new(
                v(o.x + 0.5, o.y - HE, FLOOR_WZ - LEDGE_DROP - 0.5),
                v(o.x + HE, o.y + HE, FLOOR_WZ + 10.0),
            ),
        );
        for t in floor_tris_world(o.x - HE, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ) {
            scene.insert_cell_triangle(CELL_ID, t);
        }
        let env = DriftEnv { scene };
        let begin = pose_at(FCX, FCY, FLOOR_WZ);
        let end = pose_at(FCX + 1.3, FCY, FLOOR_WZ - SINK);
        let input = input_for(begin, end);
        let f = faithful_find_transitional_position(&env, &input, true, true);
        assert!(f.pose.coords.x > begin.coords.x, "walk advanced");
        assert!(f.pose.is_indoors(), "still indoors");
        assert_eq!(
            f.pose.landblock_id,
            Guid(NEXT_ID),
            "low word must re-derive to the entered cell (was pinned to begin: {:?})",
            f.pose.landblock_id
        );
    }

    // ── indoor→indoor cell transit, pre-bake fallback (2026-07-18) ──
    // Same walk as above but WITHOUT a cell physics BSP: the bridge falls back
    // to the approximate pipeline (`find_transitional_position`, the indoor
    // pre-bake guard at the top of `faithful_find_transitional_position`), so
    // the re-derive must ALSO live in that pipeline's per-step
    // `step_cell_transit_flips` (its indoor else-arm — the legacy-slice parity
    // guard, handoff-6 §3.2). Portal edges CELL↔NEXT are seeded so the
    // interior-doorway relax lifts the cell-AABB containment net at the seam
    // (the doorway straddle), exactly as a baked dungeon's portal graph would.
    #[test]
    fn indoor_walk_prebake_fallback_rederives_envcell_low_word() {
        const NEXT_ID: u32 = 0x1234_0101;
        let o = cell_origin();
        let mut scene = SpatialScene::new();
        // NO insert_cell_physics_bsp — forces the approximate-pipeline fallback.
        scene.insert_cell_aabb(
            CELL_ID,
            Aabb::new(
                v(o.x - HE, o.y - HE, FLOOR_WZ - LEDGE_DROP - 0.5),
                v(o.x + 0.5, o.y + HE, FLOOR_WZ + 10.0),
            ),
        );
        scene.insert_cell_aabb(
            NEXT_ID,
            Aabb::new(
                v(o.x + 0.5, o.y - HE, FLOOR_WZ - LEDGE_DROP - 0.5),
                v(o.x + HE, o.y + HE, FLOOR_WZ + 10.0),
            ),
        );
        // Floor triangles keyed per owning cell (the approximate pipeline looks
        // them up by `current_cell`).
        for t in floor_tris_world(o.x - HE, o.x + 0.5, o.y - HE, o.y + HE, FLOOR_WZ) {
            scene.insert_cell_triangle(CELL_ID, t);
        }
        for t in floor_tris_world(o.x + 0.5, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ) {
            scene.insert_cell_triangle(NEXT_ID, t);
        }
        scene.insert_cell_portal(CELL_ID, NEXT_ID);
        scene.insert_cell_portal(NEXT_ID, CELL_ID);
        let env = DriftEnv { scene };
        let begin = pose_at(FCX, FCY, FLOOR_WZ);
        let end = pose_at(FCX + 1.3, FCY, FLOOR_WZ - SINK);
        let input = input_for(begin, end);
        let f = faithful_find_transitional_position(&env, &input, true, true);
        assert!(f.pose.coords.x > begin.coords.x, "walk advanced");
        assert!(
            f.pose.coords.x > FCX + 0.5,
            "walk crossed the cell seam (x = {})",
            f.pose.coords.x
        );
        assert!(f.pose.is_indoors(), "still indoors");
        assert!(f.cell_changed, "transit reported as a cell change");
        assert_eq!(
            f.pose.landblock_id,
            Guid(NEXT_ID),
            "pre-bake fallback must re-derive the low word too (pinned: {:?})",
            f.pose.landblock_id
        );
    }

    // ── (a') USE_RETAIL_GROUND wiring (2026-07-02) ──
    // Same flat walk with the retail ground gates on: the entry latch
    // (CONTACT|ON_WALKABLE), OBJECTINFO step_down and the contact-plane seed
    // must not regress the grounded indoor walk, and the outcome must carry
    // the settled contact plane for the caller's cross-frame store (the
    // retail SetPositionInternal copy). The plane's normal must be the flat
    // floor's +Z (a walkable plane — FLOOR_Z gate satisfied).
    #[test]
    fn retail_ground_flat_walk_stays_grounded_and_carries_plane() {
        let env = flat_floor_env();
        let begin = pose_at(FCX, FCY, FLOOR_WZ);
        let end = pose_at(FCX + 1.3, FCY, FLOOR_WZ - SINK);
        let mut input = input_for(begin, end);
        input.gates.retail_ground = true;
        let f = faithful_find_transitional_position(&env, &input, true, true);
        assert_in_cell_aabb(&env, &f);
        assert_no_overshoot(&begin, &end, &f);
        assert!(f.pose.coords.x > begin.coords.x, "retail_ground still advances");
        assert!(f.grounded, "grounded latch survives the retail entry stamp");
        let (plane, _cell) = f
            .contact_plane
            .expect("retail_ground surfaces the settled contact plane");
        assert!(
            plane.normal.z > 0.9,
            "flat floor plane carried out: N = {:?}",
            plane.normal
        );

        // Round-trip: seeding the carried plane back in (the next slice's
        // entry) keeps the walk grounded and advancing — the retail
        // `get_object_info` → `init_contact_plane` carry.
        let begin2 = f.pose;
        let end2 = pose_at(begin2.coords.x + 1.0, FCY, begin2.coords.z - SINK);
        let mut input2 = input_for(begin2, end2);
        input2.gates.retail_ground = true;
        input2.last_contact_plane = f.contact_plane;
        let f2 = faithful_find_transitional_position(&env, &input2, true, true);
        assert!(f2.grounded, "seeded entry stays grounded");
        assert!(f2.pose.coords.x > begin2.coords.x, "seeded entry advances");
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
        let with = faithful_find_transitional_position(&env, &input, true, true);

        // CONTROL: no static (env floor only).
        let ctrl = DriftEnv { scene: floor_only_scene() };
        let without = faithful_find_transitional_position(&ctrl, &input, true, true);

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

    /// Phase E3.4: per-static SCALE. The same static wall (local x=WALL_X_LOCAL)
    /// collides at its SCALED world position — a scale-2 static stops the mover
    /// ~2× farther than a scale-1 one. Retail caches the sweep into the part's
    /// frame using the PART's `gfxobj_scale.z` (acclient.c:314669), so the
    /// static's OWN scale (not the mover's) drives the static sweep.
    #[test]
    fn static_object_scale_scales_collision_distance() {
        let wall_polys = || {
            let mut p = HashMap::new();
            p.insert(
                1u16,
                poly(vec![
                    v(WALL_X_LOCAL, -HE, 0.0),
                    v(WALL_X_LOCAL, -HE, WALL_H),
                    v(WALL_X_LOCAL, HE, WALL_H),
                    v(WALL_X_LOCAL, HE, 0.0),
                ]),
            );
            p
        };
        let o = cell_origin();
        let build = |s: f32| -> DriftEnv {
            let mut scene = SpatialScene::new();
            let mut floor = HashMap::new();
            floor.insert(1u16, floor_poly_local(-HE, HE, 0.0));
            scene.insert_cell_physics_bsp(CELL_ID, bsp_from(floor));
            seed_common(
                &mut scene,
                floor_tris_world(o.x - HE, o.x + HE, o.y - HE, o.y + HE, FLOOR_WZ),
            );
            let mut wall = bsp_from(wall_polys());
            wall.scale = s; // the static's own scale (E3.4)
            scene.insert_cell_static_physics_bsp(CELL_ID, wall);
            DriftEnv { scene }
        };
        // Multi-frame walk so the mover reaches even the scale-2 wall (~FCX+2).
        let flat = |_x: f32| FLOOR_WZ;
        let start = pose_at(FCX, FCY, FLOOR_WZ);
        let x1 = frame_walk(&build(1.0), start, 0.3, flat, 20, true)
            .last()
            .unwrap()
            .coords
            .x;
        let x2 = frame_walk(&build(2.0), start, 0.3, flat, 20, true)
            .last()
            .unwrap()
            .coords
            .x;
        eprintln!("[E3.4 scale] scale1 stop x={x1:.3}  scale2 stop x={x2:.3}");
        assert!(
            x2 > x1 + 0.5,
            "scaled static must collide farther (its own scale drives the sweep): scale1 x={x1}, scale2 x={x2}"
        );
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
            let f = faithful_find_transitional_position(&env, &input, true, true);
            assert_in_cell_aabb(&env, &f);
            assert_no_overshoot(&begin, &end, &f);
            assert_pose_roundtrips_driver(&env, &input, &f);
            assert!(!f.cell_changed, "single-cell ⇒ no cell change");
        }
    }

    // ── Delegation routing (pure marshalling, fully RESOLVED on the laptop) ──
    // The dispatcher's faithful arm must be byte-identical to the approximate
    // path for the cases the bridge delegates: OUTDOOR poses with the outdoor
    // flag OFF (`?faithfulOutdoor=off`, the Phase D rollback regression guard)
    // and indoor poses whose cell has no physics BSP (the pre-bake guard).
    #[test]
    fn outdoor_flag_off_delegates_to_approximate() {
        // Outdoor landblock (low word 0 ⇒ !is_indoors): with the outdoor flag
        // OFF the faithful entry delegates straight to the approximate pipeline.
        let mut scene = SpatialScene::new();
        // No terrain resident; an empty outdoor scene exercises pure delegation.
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
        // faithful_outdoor = false ⇒ the outdoor branch rolls back to heightfield.
        let f = faithful_find_transitional_position(&env, &input, false, true);
        assert_eq!(a.pose, f.pose, "outdoor flag-off delegates byte-identically");
        assert_eq!(a.grounded, f.grounded);
        assert_eq!(a.cell_changed, f.cell_changed);
    }

    // With the outdoor flag ON but the begin landblock's terrain NOT resident
    // (unbaked-landblock guard), the faithful entry STILL delegates to the
    // heightfield path — the parallel of the indoor no-BSP guard. Proves a
    // pre-load outdoor pose never free-falls through the (absent) terrain.
    #[test]
    fn outdoor_flag_on_unbaked_landblock_delegates() {
        let scene = SpatialScene::new(); // no terrain heights populated
        let env = DriftEnv { scene };
        let begin = WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: v(50.0, 50.0, 10.0),
            rotation: Quaternion::identity(),
        };
        let mut end = begin;
        end.coords.x += 1.3;
        let input = input_for(begin, end);
        // Guard precondition: outdoor pose, terrain landblock NOT resident.
        assert!(!begin.is_indoors());
        assert!(!env.scene.terrain_landblock_resident(env.scene.current_cell(&begin)));
        let a = find_transitional_position(&env, &input);
        let f = faithful_find_transitional_position(&env, &input, true, true);
        assert_eq!(a.pose, f.pose, "unbaked outdoor LB delegates byte-identically");
        assert_eq!(a.grounded, f.grounded);
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
        let f = faithful_find_transitional_position(&env, &input, true, true);
        assert_eq!(a.pose, f.pose, "indoor-no-BSP delegates byte-identically");
        assert_eq!(a.grounded, f.grounded);
    }

    // ── Phase D / WS3: OUTDOOR terrain collision (CLandCell::find_collisions) ──
    //
    // These exercise the OUTDOOR cell body END-TO-END through the real driver
    // (`CTransition::find_valid_position`) + the real `SceneWorld`: its
    // `add_all_outside_cells` floods the terrain ring via the WS1 seams, and its
    // `get_visible` routes the player's CURRENT outdoor cell to the land-cell
    // builder so `insert_into_cell` collides it against its terrain triangles.
    // The dispatcher entry (`faithful_find_transitional_position`) still delegates
    // OUTDOOR poses to the heightfield path (WS4 owns the flip), so the test
    // drives the driver directly — the outdoor twin of `raw_drive`.

    // Outdoor landblock (blockX=2, blockY=3) → high word 0x0203_0000; WORLD origin
    // (384, 576). Terrain math is landblock-local; world = origin + local.
    const OLB: u32 = 0x0203_0000;
    const OLB_OX: f32 = 2.0 * 192.0; // 384
    const OLB_OY: f32 = 3.0 * 192.0; // 576

    /// An OUTDOOR pose: `landblock_id` low word 0 (so `is_indoors()==false` and
    /// `current_cell` derives the cell from the local XY), `coords` landblock-local.
    fn outdoor_pose(world_x: f32, world_y: f32, world_z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(OLB),
            coords: v(world_x - OLB_OX, world_y - OLB_OY, world_z),
            rotation: Quaternion::identity(),
        }
    }

    /// WORLD XY of an in-block cell's centre.
    fn outdoor_cell_center(cell_x: u32, cell_y: u32) -> (f32, f32) {
        (
            OLB_OX + cell_x as f32 * 24.0 + 12.0,
            OLB_OY + cell_y as f32 * 24.0 + 12.0,
        )
    }

    fn player() -> ObjectInfo {
        ObjectInfo::for_local_player(None, None, true, Guid(0x5000_0002))
    }

    /// Drive the FULL faithful driver over an OUTDOOR begin→end (the outdoor twin
    /// of `raw_drive`): build the two-sphere capsule + path in WORLD coords, run
    /// `find_valid_position` against the real `SceneWorld`. Returns the raw driver
    /// (settled `curr_pos`, ON_WALKABLE state) and the `found` flag.
    fn outdoor_raw_drive(
        scene: &SpatialScene,
        begin: &WorldPosition,
        end: &WorldPosition,
        object: &ObjectInfo,
    ) -> (CTransition, i32) {
        let begin_cell = scene.current_cell(begin);
        let end_cell = scene.current_cell(end);
        let mut bf = Frame::identity();
        bf.origin = begin.global_coords();
        let begin_pos = Position { objcell_id: begin_cell, frame: bf };
        let mut ef = Frame::identity();
        ef.origin = end.global_coords();
        let end_pos = Position { objcell_id: end_cell, frame: ef };
        let r = object.radius;
        let h = object.height;
        let spheres = [
            Sphere { center: v(0.0, 0.0, r), radius: r },
            Sphere { center: v(0.0, 0.0, (h - r).max(r)), radius: r },
        ];
        let mut t = CTransition::new();
        t.object_info.scale = 1.0;
        t.object_info.state = object.state;
        t.object_info.step_up_height = object.step_up_height;
        t.object_info.step_down_height = object.step_down_height;
        t.object_info.ethereal = object.ethereal;
        t.init_sphere(2, &spheres, 1.0);
        t.init_path(Some(begin_cell), Some(&begin_pos), &end_pos);
        let world = SceneWorld::new(scene);
        let mover = FaithfulMover { has_gravity: true };
        let found = t.find_valid_position(&world, &mover);
        (t, found)
    }

    /// Settled feet position (WORLD) + grounded latch (ON_WALKABLE).
    fn settled(t: &CTransition) -> (Vector3, bool) {
        (
            t.sphere_path.curr_pos.frame.origin,
            (t.object_info.state & object_info_state::ON_WALKABLE) != 0,
        )
    }

    fn outdoor_scene(heights: [f32; 81]) -> SpatialScene {
        let mut scene = SpatialScene::new();
        scene.populate_terrain_heights(OLB, heights);
        scene
    }

    /// `outdoor_scene` + the E3.6 per-vertex terrain TYPE codes (`vx*9+vy`,
    /// `(terrain>>2)&0x1F`); water codes are `16..=20`.
    fn outdoor_scene_with_water(heights: [f32; 81], codes: [u8; 81]) -> SpatialScene {
        let mut scene = outdoor_scene(heights);
        scene.populate_terrain_water_codes(OLB, codes);
        scene
    }

    // ── Phase E1 / WS-C terrain up-slope helpers ──
    //
    // A landblock terrain grid that rises LINEARLY in +x at `rise_per_m` (a plane,
    // so the collision triangle height == the analytic height everywhere). The 9×9
    // vertices sit every 24 m, so `h[vx*9+vy] = 50 + rise_per_m*24*vx`. A
    // `rise_per_m` of 0.5 ⇒ a 1:2 up-slope (normal.z 0.894 > FLOOR_Z 0.664 ⇒
    // WALKABLE), the outdoor twin of the indoor RAMP. `rise_per_m` ≥ ~1.5 (≈ 56°)
    // is a non-walkable CLIFF.
    fn slope_grid(rise_per_m: f32) -> [f32; 81] {
        let mut h = [0.0f32; 81];
        for vx in 0..9usize {
            for vy in 0..9usize {
                h[vx * 9 + vy] = 50.0 + rise_per_m * 24.0 * vx as f32;
            }
        }
        h
    }

    /// World feet-z of the linear slope surface at WORLD x (landblock-local
    /// `x − OLB_OX`, planar ⇒ `50 + rise_per_m*(x − OLB_OX)`).
    fn terrain_wz(world_x: f32, rise_per_m: f32) -> f32 {
        50.0 + rise_per_m * (world_x - OLB_OX)
    }

    /// Drive `frames` movement frames up an OUTDOOR slope through the PUBLIC entry
    /// (`faithful_find_transitional_position`, the WS4 outdoor flip): each frame
    /// advances +`dx` in WORLD x toward `surface_wz(x)` minus a gravity `SINK`
    /// (the live movement cadence), threading the settled pose forward and the
    /// `faithful_stepup` toggle. The outdoor flag is ON; only the climb toggle
    /// varies. Returns every settled pose (start first) for monotonic/jitter and
    /// height-tracking assertions.
    fn outdoor_frame_walk(
        env: &DriftEnv,
        start: WorldPosition,
        dx: f32,
        surface_wz: impl Fn(f32) -> f32,
        frames: usize,
        stepup_on: bool,
    ) -> Vec<WorldPosition> {
        let mut pose = start;
        let mut trail = vec![pose];
        for _ in 0..frames {
            let g = pose.global_coords();
            let nx = g.x + dx;
            let end = outdoor_pose(nx, g.y, surface_wz(nx) - SINK);
            let out =
                faithful_find_transitional_position(env, &input_for(pose, end), true, stepup_on);
            pose = out.pose;
            trail.push(pose);
        }
        trail
    }

    // (a0) DIRECT cell-body proof (the WS3 deliverable in isolation): obtain the
    // outdoor land cell via the real `get_visible` routing and call its
    // `find_collisions` with a mover whose low sphere penetrates FLAT terrain.
    // The terrain path (find_terrain_poly + validate_walkable) must report a
    // walkable up-normal contact and snap the sphere up onto the surface — the
    // grounded source the driver's `validate_transition` latches into ON_WALKABLE.
    #[test]
    fn outdoor_terrain_direct_grounds_penetrating_mover() {
        use holtburger_dat::transition::objcell::CellWorld;
        const Z: f32 = 50.0;
        let scene = outdoor_scene([Z; 81]);
        let world = SceneWorld::new(&scene);
        let cell_id = OLB | (4 * 8 + 4 + 1); // cell (4,4)
        let cell = world.get_visible(cell_id).expect("outdoor land cell built");
        assert_eq!(cell.id(), cell_id, "get_visible routes outdoor → land cell");
        let (cx, cy) = outdoor_cell_center(4, 4);
        let r = player().radius;
        let h = player().height;
        let spheres = [
            Sphere { center: v(0.0, 0.0, r), radius: r },
            Sphere { center: v(0.0, 0.0, (h - r).max(r)), radius: r },
        ];
        let mut t = CTransition::new();
        t.object_info.scale = 1.0;
        t.object_info.state = object_info_state::CONTACT;
        t.init_sphere(2, &spheres, 1.0);
        // curr at the surface, check dipped 0.2 below (penetrating the floor).
        let mut curr = Frame::identity();
        curr.origin = v(cx, cy, Z);
        let mut chk = Frame::identity();
        chk.origin = v(cx, cy, Z - 0.2);
        t.sphere_path.curr_pos = Position { objcell_id: cell_id, frame: curr };
        t.sphere_path.check_pos = Position { objcell_id: cell_id, frame: chk };
        t.sphere_path.curr_cell = Some(cell_id);
        t.sphere_path.check_cell = Some(cell_id);
        t.sphere_path.cache_global_sphere(None);
        let code = cell.find_collisions(&mut t);
        let cp = t.collision_info.contact_plane.expect("terrain set a contact plane");
        eprintln!(
            "[outdoor-direct] code={code} N={:?} check_z->{:.4}",
            cp.normal, t.sphere_path.check_pos.frame.origin.z
        );
        assert_eq!(code, 3, "penetrating flat terrain ⇒ ADJUSTED");
        assert!(cp.normal.z > 0.99, "terrain contact normal is up: {:?}", cp.normal);
        assert!(
            t.object_info.is_valid_walkable(&cp.normal),
            "flat terrain is walkable support"
        );
        // The sphere was pushed back up out of the surface (feet ≈ Z).
        assert!(
            (t.sphere_path.check_pos.frame.origin.z - Z).abs() < 1e-3,
            "feet snapped to terrain {Z}: got {}",
            t.sphere_path.check_pos.frame.origin.z
        );
    }

    // ── Phase E3.6: outdoor water type / depth ──

    #[test]
    fn classify_cell_water_matches_calc_cell_water() {
        // Water terrain codes are 16..=20 (the TERRAIN_SURF_CHAR==WATER band,
        // acclient.c:41303 / ACE SurfChar). All 4 corners ⇒ EntirelyWater.
        let (wt, f) = classify_cell_water([19, 19, 19, 19]);
        assert_eq!(wt, WaterType::EntirelyWater);
        assert_eq!(f, [true; 4]);
        // Mixed corners ⇒ PartiallyWater; flags track each corner.
        let (wt, f) = classify_cell_water([16, 0, 20, 0]);
        assert_eq!(wt, WaterType::PartiallyWater);
        assert_eq!(f, [true, false, true, false]);
        // 15 (Snow) and 21 (Reserved) are SOLID ⇒ NotWater.
        let (wt, f) = classify_cell_water([0, 1, 15, 21]);
        assert_eq!(wt, WaterType::NotWater);
        assert_eq!(f, [false; 4]);
        // 22/23 are SOLID on the faithful path (retail TERRAIN_SURF_CHAR/ACE
        // SurfChar), UNLIKE the legacy WorldState classifier which counts them.
        assert_eq!(classify_cell_water([22, 23, 22, 23]).0, WaterType::NotWater);
    }

    #[test]
    fn outdoor_water_cell_type_and_depth() {
        use holtburger_dat::transition::objcell::CellWorld;
        const Z: f32 = 50.0;
        let cell_id = OLB | (4 * 8 + 4 + 1); // cell (4,4)

        // Entirely-water cell: every vertex water ⇒ 0.9 wading depth everywhere.
        let scene = outdoor_scene_with_water([Z; 81], [19u8; 81]);
        let world = SceneWorld::new(&scene);
        let cell = world.get_visible(cell_id).expect("cell");
        assert_eq!(cell.water_type(), WaterType::EntirelyWater);
        assert!((cell.get_water_depth(v(100.0, 100.0, Z)) - 0.89999998).abs() < 1e-6);

        // Partially-water cell: only the SW corner (vertex cx*9+cy = 40) is water
        // ⇒ 0.45 in the SW quadrant, 0.1 in the (dry) NE quadrant.
        let mut codes = [0u8; 81];
        codes[4 * 9 + 4] = 19; // SW corner of cell (4,4)
        let scene = outdoor_scene_with_water([Z; 81], codes);
        let world = SceneWorld::new(&scene);
        let cell = world.get_visible(cell_id).expect("cell");
        assert_eq!(cell.water_type(), WaterType::PartiallyWater);
        let sw = cell.get_water_depth(v(100.0, 100.0, Z)); // local 96..108 ⇒ SW
        let ne = cell.get_water_depth(v(114.0, 114.0, Z)); // local 108..120 ⇒ NE
        assert!((sw - 0.44999999).abs() < 1e-6, "SW (water corner) depth: {sw}");
        assert!((ne - 0.1).abs() < 1e-6, "NE (dry corner) depth: {ne}");

        // No codes resident ⇒ NotWater / 0 depth (fail-soft, today's behaviour).
        let scene = outdoor_scene([Z; 81]);
        let world = SceneWorld::new(&scene);
        let cell = world.get_visible(cell_id).expect("cell");
        assert_eq!(cell.water_type(), WaterType::NotWater);
        assert_eq!(cell.get_water_depth(v(100.0, 100.0, Z)), 0.0);
    }

    #[test]
    fn outdoor_entirely_water_cell_denies_walkable_contact() {
        use holtburger_dat::transition::objcell::CellWorld;
        use holtburger_dat::transition::types::TransitionState;
        const Z: f32 = 50.0;
        let cell_id = OLB | (4 * 8 + 4 + 1);
        let (cx, cy) = outdoor_cell_center(4, 4);
        let r = player().radius;
        let h = player().height;

        // find_collisions on a mover penetrating flat terrain 0.2 below; returns
        // (code, whether a walkable contact plane was recorded → grounded).
        let run = |codes: [u8; 81]| -> (i32, bool) {
            let scene = outdoor_scene_with_water([Z; 81], codes);
            let world = SceneWorld::new(&scene);
            let cell = world.get_visible(cell_id).expect("cell");
            let spheres = [
                Sphere { center: v(0.0, 0.0, r), radius: r },
                Sphere { center: v(0.0, 0.0, (h - r).max(r)), radius: r },
            ];
            let mut t = CTransition::new();
            t.object_info.scale = 1.0;
            t.object_info.state = object_info_state::CONTACT;
            t.init_sphere(2, &spheres, 1.0);
            let mut curr = Frame::identity();
            curr.origin = v(cx, cy, Z);
            let mut chk = Frame::identity();
            chk.origin = v(cx, cy, Z - 0.2);
            t.sphere_path.curr_pos = Position { objcell_id: cell_id, frame: curr };
            t.sphere_path.check_pos = Position { objcell_id: cell_id, frame: chk };
            t.sphere_path.curr_cell = Some(cell_id);
            t.sphere_path.check_cell = Some(cell_id);
            t.sphere_path.cache_global_sphere(None);
            let code = cell.find_collisions(&mut t);
            (code, t.collision_info.contact_plane.is_some())
        };

        // Dry terrain: the penetrating mover is ADJUSTED up onto a walkable contact.
        let (dry_code, dry_grounded) = run([0u8; 81]);
        assert_eq!(dry_code, TransitionState::Adjusted as i32, "dry ⇒ adjusted up");
        assert!(dry_grounded, "dry terrain records a walkable contact plane");

        // Entirely-water cell: the 0.9 wading depth lifts the support plane above
        // the mover's feet ⇒ it HOVERS (Ok) with NO walkable contact — the cell
        // gives no ground to stand on (faithful `validate_walkable` v17 > 0 branch,
        // acclient.c:314227; the "can't stand on deep water" outcome).
        let (water_code, water_grounded) = run([19u8; 81]);
        assert_eq!(water_code, TransitionState::Ok as i32, "all-water ⇒ no adjust");
        assert!(!water_grounded, "all-water cell records NO walkable contact");
    }

    // (a0b) DIRECT cell-body proof on a SLOPED grid: the contact plane the terrain
    // sets reproduces the WS2 collision-triangle height (≡ the shared height
    // sampler) at the query XY, and the sphere snaps onto it. Proves "height
    // tracks terrain_height_at within tolerance" at the cell level.
    #[test]
    fn outdoor_terrain_direct_height_tracks_slope() {
        use holtburger_dat::transition::objcell::CellWorld;
        // Linear ramp in vx (rise 3 per cell ⇒ ~7° walkable slope).
        let mut h = [0.0f32; 81];
        for vx in 0..9usize {
            for vy in 0..9usize {
                h[vx * 9 + vy] = 50.0 + 3.0 * vx as f32;
            }
        }
        let scene = outdoor_scene(h);
        let world = SceneWorld::new(&scene);
        let cell_id = OLB | (3 * 8 + 4 + 1); // cell (3,4)
        let cell = world.get_visible(cell_id).expect("outdoor land cell");
        let (cx, cy) = outdoor_cell_center(3, 4);
        // Terrain height at this XY: linear ⇒ 50 + (x_local/24)*3 = 50 + x_local/8.
        let want_z = 50.0 + (cx - OLB_OX) / 8.0;
        let r = player().radius;
        let h2 = player().height;
        let spheres = [
            Sphere { center: v(0.0, 0.0, r), radius: r },
            Sphere { center: v(0.0, 0.0, (h2 - r).max(r)), radius: r },
        ];
        let mut t = CTransition::new();
        t.object_info.scale = 1.0;
        t.object_info.state = object_info_state::CONTACT;
        t.init_sphere(2, &spheres, 1.0);
        let mut curr = Frame::identity();
        curr.origin = v(cx, cy, want_z);
        let mut chk = Frame::identity();
        chk.origin = v(cx, cy, want_z - 0.2); // dip below the sloped surface
        t.sphere_path.curr_pos = Position { objcell_id: cell_id, frame: curr };
        t.sphere_path.check_pos = Position { objcell_id: cell_id, frame: chk };
        t.sphere_path.curr_cell = Some(cell_id);
        t.sphere_path.check_cell = Some(cell_id);
        t.sphere_path.cache_global_sphere(None);
        let code = cell.find_collisions(&mut t);
        let cp = t.collision_info.contact_plane.expect("slope contact plane");
        let got_z = t.sphere_path.check_pos.frame.origin.z;
        eprintln!("[outdoor-slope-direct] code={code} N={:?} got_z={got_z:.4} want_z={want_z:.4}", cp.normal);
        assert_eq!(code, 3, "penetrating walkable slope ⇒ ADJUSTED");
        assert!(t.object_info.is_valid_walkable(&cp.normal), "gentle slope is walkable");
        assert!(
            (got_z - want_z).abs() < 1e-3,
            "feet track sloped terrain height {want_z}: got {got_z}"
        );
    }

    // (a0c) DIRECT cell-body proof of the CLIFF: a steep terrain triangle does
    // NOT provide walkable support — the contact normal it reports fails
    // `is_valid_walkable` (slope ≫ 48°). This is the per-cell basis of the
    // cliff-stop. Off-cell points hit no triangle (find_terrain_poly None ⇒ OK).
    #[test]
    fn outdoor_terrain_direct_cliff_not_walkable() {
        use holtburger_dat::transition::objcell::CellWorld;
        // Steep wall in cell_x=6 (vx 6→7 jumps 50→200 over 24 m ⇒ ~81°).
        let mut h = [50.0f32; 81];
        for vy in 0..9usize {
            h[7 * 9 + vy] = 200.0;
            h[8 * 9 + vy] = 200.0;
        }
        let scene = outdoor_scene(h);
        let world = SceneWorld::new(&scene);
        let cell_id = OLB | (6 * 8 + 4 + 1); // cell (6,4) — the cliff
        let cell = world.get_visible(cell_id).expect("outdoor land cell");
        let (cx, cy) = outdoor_cell_center(6, 4);
        let r = player().radius;
        let hh = player().height;
        let spheres = [
            Sphere { center: v(0.0, 0.0, r), radius: r },
            Sphere { center: v(0.0, 0.0, (hh - r).max(r)), radius: r },
        ];
        let mut t = CTransition::new();
        t.object_info.scale = 1.0;
        // NOT yet on walkable support (so validate_walkable records the contact).
        t.object_info.state = object_info_state::CONTACT;
        t.init_sphere(2, &spheres, 1.0);
        // Penetrating the steep face from below.
        let mut curr = Frame::identity();
        curr.origin = v(cx, cy, 90.0);
        let mut chk = Frame::identity();
        chk.origin = v(cx, cy, 80.0);
        t.sphere_path.curr_pos = Position { objcell_id: cell_id, frame: curr };
        t.sphere_path.check_pos = Position { objcell_id: cell_id, frame: chk };
        t.sphere_path.curr_cell = Some(cell_id);
        t.sphere_path.check_cell = Some(cell_id);
        t.sphere_path.cache_global_sphere(None);
        let _ = cell.find_collisions(&mut t);
        let cp = t.collision_info.contact_plane.expect("steep contact plane recorded");
        eprintln!("[outdoor-cliff-direct] N={:?} valid_walkable={}", cp.normal, t.object_info.is_valid_walkable(&cp.normal));
        assert!(cp.normal.z < 0.664, "steep cliff normal is below WalkableAllowance: {:?}", cp.normal);
        assert!(
            !t.object_info.is_valid_walkable(&cp.normal),
            "steep cliff does NOT provide walkable support (the cliff-stop)"
        );

        // A point off this cell's footprint hits no triangle ⇒ terrain OK (no
        // contact), so the mover falls through to statics (none) ⇒ OK.
        let mut t2 = CTransition::new();
        t2.object_info.scale = 1.0;
        t2.object_info.state = object_info_state::CONTACT;
        t2.init_sphere(2, &spheres, 1.0);
        let mut off = Frame::identity();
        off.origin = v(cx - 60.0, cy, 80.0); // well outside cell (6,4)
        t2.sphere_path.curr_pos = Position { objcell_id: cell_id, frame: off };
        t2.sphere_path.check_pos = Position { objcell_id: cell_id, frame: off };
        t2.sphere_path.curr_cell = Some(cell_id);
        t2.sphere_path.check_cell = Some(cell_id);
        t2.sphere_path.cache_global_sphere(None);
        let code_off = cell.find_collisions(&mut t2);
        assert_eq!(code_off, 1, "off-cell point ⇒ no terrain poly ⇒ OK");
        assert!(t2.collision_info.contact_plane.is_none(), "no contact off the cell");
    }

    // (a) FLAT outdoor terrain: a mover walking across stays grounded over the
    // whole sweep and its feet track the terrain height (z ≈ 50). The mover
    // routes through the outdoor `CLandCell` terrain path (find_terrain_poly +
    // validate_walkable), latching ON_WALKABLE from the flat contact plane.
    #[test]
    fn outdoor_flat_terrain_stays_grounded() {
        const Z: f32 = 50.0;
        let scene = outdoor_scene([Z; 81]);
        let (sx, sy) = outdoor_cell_center(4, 4); // (492, 684)
        let begin = outdoor_pose(sx, sy, Z);
        // Walk +x ~12 (into the neighbour cell), dipping below the surface (a
        // gravity stand-in) — the terrain must snap the feet back up to Z.
        let end = outdoor_pose(sx + 12.0, sy, Z - 0.15);
        let (t, found) = outdoor_raw_drive(&scene, &begin, &end, &player());
        let (feet, grounded) = settled(&t);
        eprintln!(
            "[outdoor-flat] found={found} begin_cell={:#x} feet=({:.3},{:.3},{:.3}) grounded={grounded}",
            scene.current_cell(&begin), feet.x, feet.y, feet.z
        );
        assert_eq!(found, 1, "flat outdoor sweep settles");
        assert!(feet.x > begin.global_coords().x + 0.5, "mover advanced east");
        assert!(grounded, "flat terrain latches ON_WALKABLE (grounded)");
        assert!(
            (feet.z - Z).abs() < player().radius,
            "feet track terrain height {Z}: got {}",
            feet.z
        );
    }

    // (b) GENTLE (walkable) slope: the feet track the terrain triangle height.
    // The grid is linear in vx (rise 3 per 24 m cell ⇒ ~7° slope, normal.z≈0.99 >
    // WalkableAllowance), so the collision plane height at any local x is exactly
    // 50 + (x_local/24)*3 = 50 + x_local/8 — the invariant WS2 proved equals the
    // shared height sampler. The settled feet z must match that at the settled x.
    //
    // The mover walks CROSS-slope (+y), where the terrain height is constant (the
    // grid varies only in vx), so it advances while staying grounded on the TILTED
    // contact plane and tracking the terrain height. (Walking straight UP a slope
    // is gated on the resolver's PHASE3 `step_up` port — the same divergence the
    // indoor wall/ledge tests document — so this test exercises the grounded /
    // height-tracking axis the WS3 terrain body owns, not the climb.)
    #[test]
    fn outdoor_gentle_slope_tracks_terrain_height() {
        let mut h = [0.0f32; 81];
        for vx in 0..9usize {
            for vy in 0..9usize {
                h[vx * 9 + vy] = 50.0 + 3.0 * vx as f32;
            }
        }
        let scene = outdoor_scene(h);
        let (sx, sy) = outdoor_cell_center(3, 4);
        // Terrain height at this XY (constant along +y): 50 + x_local/8.
        let z0 = 50.0 + (sx - OLB_OX) / 8.0;
        let begin = outdoor_pose(sx, sy, z0);
        let end = outdoor_pose(sx, sy + 12.0, z0 - 0.12); // walk cross-slope (+y), dipping
        let (t, found) = outdoor_raw_drive(&scene, &begin, &end, &player());
        let (feet, grounded) = settled(&t);
        // Expected terrain height under the settled feet (linear ⇒ plane-exact).
        let want = 50.0 + (feet.x - OLB_OX) / 8.0;
        eprintln!(
            "[outdoor-slope] found={found} feet=({:.3},{:.3},{:.3}) grounded={grounded} want_z={want:.3}",
            feet.x, feet.y, feet.z
        );
        assert_eq!(found, 1, "cross-slope walk settles");
        assert!(grounded, "walkable slope latches ON_WALKABLE");
        assert!(feet.y > begin.global_coords().y + 0.5, "advanced cross-slope (+y)");
        assert!(
            (feet.z - want).abs() < 0.1,
            "feet z {} tracks tilted terrain plane height {want} (dev {})",
            feet.z,
            (feet.z - want).abs()
        );
    }

    // (c) STEEP cliff: a mover approaching a non-walkable rise (slope ≫ 48°) from
    // a flat cell STOPS short — it does NOT climb the cliff. Control: the SAME
    // start on FULLY-flat terrain advances clearly further. The cliff (vx≥7 jumps
    // 50→200 over 24 m ⇒ ~81°, normal.z≈0.16 < WalkableAllowance) is the wall.
    #[test]
    fn outdoor_steep_cliff_stops_mover() {
        // Flat z=50 for vx 0..6, then a steep wall at vx 7..8 (cell_x=6 is the cliff).
        let mut h = [50.0f32; 81];
        for vy in 0..9usize {
            h[7 * 9 + vy] = 200.0;
            h[8 * 9 + vy] = 200.0;
        }
        let scene = outdoor_scene(h);
        // Start centred in the flat cell (5,4); cell 6 (world x ∈ [528,552]) is the cliff.
        let (sx, sy) = outdoor_cell_center(5, 4); // (516, 684)
        let begin = outdoor_pose(sx, sy, 50.0);
        let end = outdoor_pose(sx + 20.0, sy, 50.0 - 0.15); // drive toward/into the cliff
        let (t, found) = outdoor_raw_drive(&scene, &begin, &end, &player());
        let (feet, grounded) = settled(&t);

        // Control: identical move on fully-flat terrain advances unobstructed.
        let flat = outdoor_scene([50.0f32; 81]);
        let (tc, _) = outdoor_raw_drive(&flat, &begin, &end, &player());
        let (feet_c, _) = settled(&tc);

        eprintln!(
            "[outdoor-cliff] found={found} feet=({:.3},{:.3},{:.3}) grounded={grounded}  control feet=({:.3},{:.3},{:.3})",
            feet.x, feet.y, feet.z, feet_c.x, feet_c.y, feet_c.z
        );
        // Did NOT climb the cliff (z stays near the flat base, nowhere near 200).
        assert!(feet.z < 80.0, "mover climbed the cliff: z={}", feet.z);
        // Stopped short of where the unobstructed flat control reached.
        assert!(
            feet.x < feet_c.x - 0.25,
            "cliff did not stop the mover: cliff x={} vs flat x={}",
            feet.x,
            feet_c.x
        );
        // And the flat control kept going east past the start.
        assert!(feet_c.x > begin.global_coords().x + 0.5, "flat control advanced");
    }

    // ── Phase E1b / WS-B: OUTDOOR terrain cliff still stops under the live walk ──
    //
    // The recon verdict (WS-A): retail climbs walkable TERRAIN via
    // `CLandCell::find_env_collisions` → `find_terrain_poly` →
    // `OBJECTINFO::validate_walkable` (acclient.c:354992 / 314161), which raises the
    // mover onto the triangle plane — NOT the validate up-offset early-stop, which
    // E1 v1 relaxed and WS-B reverted (a live no-op; see the indoor preamble). The
    // walkable slope climb under the live horizontal model is covered by
    // `stepup_live_horizontal_walk_climbs_walkable_slope` (which also pins the
    // flag-no-op finding). The test below is the regression guard that a too-steep
    // terrain CLIFF still STOPS the mover (Phase D `outdoor_steep_cliff_stops_mover`),
    // and that the `validate_walkable` walkability gate (`is_valid_walkable`,
    // normal.z ≥ FLOOR_Z) never lets the mover float up an unwalkable face.

    // CLIFF preservation (HORIZONTAL input, the live forward+gravity model): flat
    // terrain then a too-steep cliff (cell 6 jumps 50→200 ⇒ ~81°, normal.z 0.16 <
    // FLOOR_Z). Walked into HORIZONTALLY, the mover STOPS at the cliff base (z stays
    // ~50). A flat-terrain control advances clearly further, proving the cliff (not a
    // stuck driver) is what stops it.
    #[test]
    fn outdoor_terrain_cliff_horizontal_no_climb_with_stepup_on() {
        let mut hc = [50.0f32; 81];
        for vy in 0..9usize {
            hc[7 * 9 + vy] = 200.0; // cliff at cell 6 (vertices vx 7,8)
            hc[8 * 9 + vy] = 200.0;
        }
        let cliff_env = DriftEnv { scene: outdoor_scene(hc) };
        let flat_env = DriftEnv { scene: outdoor_scene([50.0f32; 81]) };
        let (sx, sy) = outdoor_cell_center(5, 4); // flat cell 5; cliff is cell 6 (x>=528)
        let start = outdoor_pose(sx, sy, 50.0);
        let start_g = start.global_coords();

        // Horizontal walk (constant surface z; gravity SINK provides the down bias)
        // with the climb flag ON.
        let cliff = outdoor_frame_walk(&cliff_env, start, 0.3, |_| 50.0, 60, true);
        let flat = outdoor_frame_walk(&flat_env, start, 0.3, |_| 50.0, 60, true);
        let cliff_end = cliff.last().unwrap().global_coords();
        let flat_end = flat.last().unwrap().global_coords();

        // Did NOT climb the cliff (z stays near the flat base, nowhere near 200).
        assert!(
            cliff_end.z < 80.0,
            "stepUp ON must NOT climb the terrain cliff: z {}",
            cliff_end.z
        );
        // Stopped short of where the unobstructed flat control reached.
        assert!(
            cliff_end.x < flat_end.x - 0.25,
            "cliff did not stop the mover: cliff x {} vs flat x {}",
            cliff_end.x, flat_end.x
        );
        // The flat control advanced clearly past the start (geometry, not a stuck
        // driver, is what stops the cliff climb).
        assert!(flat_end.x > start_g.x + 0.5, "flat control advanced east");
    }

    // ── T4 lip-perpendicular (USE_RETAIL_GROUND): running OFF a walkable cliff
    //    lip must HOLD at the lip (precipice edge-protect / block), NOT sail off.
    //
    //    Faithful multi-frame reproduction of the live manual-drive slice
    //    (system.rs `finish_manual_slice_via_transition`): grounded frames use a
    //    small gravity SINK + re-aimed run velocity; a `!grounded` outcome flips
    //    the mover airborne (`begin_fall`), FREEZING the planar velocity and
    //    integrating 2nd-order gravity — the exact path that lets a run-off frame
    //    turn into a plunge. `last_contact_plane` is carried across frames (the
    //    retail `SetPositionInternal` contact copy-out). retail_ground ON.
    //
    //    Terrain: a flat top z=80 (vx≤5) adjoining a 54.8° face dropping to z=46
    //    (vx≥6) — the face lives in cell_x=5 (vertices vx 5→6), lip at world x=504.
    //    The real Holtburg T4 face is this same 54.8° grade.
    fn lip_terrain(north: bool) -> [f32; 81] {
        let mut h = [80.0f32; 81];
        for a in 6..9usize {
            for b in 0..9usize {
                let idx = if north { b * 9 + a } else { a * 9 + b };
                h[idx] = 46.0;
            }
        }
        h
    }

    /// Drive `frames` of the faithful live slice toward/over the lip and return
    /// `(min_z, max_along, grounded_frac, final_pose)`. `north` runs +Y (the real
    /// T4 axis); else +X. Mirrors system.rs `finish_manual_slice_via_transition`.
    fn lip_walk(
        north: bool,
        retail_ground: bool,
        frames: usize,
        speed: f32,
    ) -> (f32, f32, f32, WorldPosition) {
        let env = DriftEnv { scene: outdoor_scene(lip_terrain(north)) };
        let (sx, sy) = outdoor_cell_center(4, 4); // (492,684): flat top, 12 m before the lip
        let mut pose = outdoor_pose(sx, sy, 80.0);
        let dt = 1.0 / 30.0f32;
        let dir = if north { v(0.0, speed, 0.0) } else { v(speed, 0.0, 0.0) };
        let mut is_airborne = false;
        let mut vvel = 0.0f32;
        let mut planar = dir;
        let mut last_cp: Option<(Plane, u32)> = None;
        let mut gg = gates();
        gg.retail_ground = retail_ground;

        let mut min_z = 80.0f32;
        let mut max_along = if north { sy } else { sx };
        let mut grounded_frames = 0usize;
        for frame in 0..frames {
            let g = pose.global_coords();
            let dz = if is_airborne {
                let az = -9.8f32;
                let d = vvel * dt + 0.5 * az * dt * dt;
                vvel += az * dt;
                d
            } else {
                planar = dir; // grounded: re-aim the run each frame
                -SINK
            };
            let descending = if is_airborne { vvel <= 0.0 } else { true };
            let end = outdoor_pose(g.x + planar.x * dt, g.y + planar.y * dt, g.z + dz);
            let input = TransitionInput {
                begin: pose,
                end,
                object: player(),
                airborne: is_airborne,
                descending,
                force_grounded: false,
                gates: gg,
                last_known_wall_normal: None,
                frames_stationary_fall: 0,
                last_contact_plane: last_cp,
            };
            let out = faithful_find_transitional_position(&env, &input, true, true);
            last_cp = out.contact_plane;
            if !is_airborne && !out.grounded {
                is_airborne = true;
                vvel = 0.0;
            } else if is_airborne && out.grounded {
                is_airborne = false;
                vvel = 0.0;
            }
            pose = out.pose;
            if out.grounded {
                grounded_frames += 1;
            }
            let gp = pose.global_coords();
            if gp.z < min_z {
                min_z = gp.z;
            }
            let along = if north { gp.y } else { gp.x };
            if along > max_along {
                max_along = along;
            }
            if std::env::var("LIP_DBG").is_ok() && frame % 4 == 0 {
                eprintln!(
                    "[lip north={north} rg={retail_ground}] f{frame}: xy=({:.2},{:.2}) z={:.2} grounded={} air={} cp={}",
                    gp.x, gp.y, gp.z, out.grounded, is_airborne, out.contact_plane.is_some()
                );
            }
        }
        let frac = grounded_frames as f32 / frames as f32;
        (min_z, max_along, frac, pose)
    }

    #[test]
    fn outdoor_lip_perpendicular_retail_holds() {
        for north in [false, true] {
            for speed in [6.0f32, 12.0, 18.0, 24.0] {
                let frames = (2400.0 / speed) as usize + 30; // ~cross the 12 m gap + hang
                let (min_z, max_along, frac, pose) = lip_walk(north, true, frames, speed);
                eprintln!(
                    "[lip north={north} spd={speed}] min_z={min_z:.2} max_along={max_along:.2} grounded_frac={frac:.2} final=({:.2},{:.2},{:.2})",
                    pose.global_coords().x, pose.global_coords().y, pose.global_coords().z
                );
                // T4 acceptance: the mover must NOT plunge down the 54.8° face — it
                // holds at the lip (or slides ALONG it). A plunge lands near z=46.
                assert!(
                    min_z > 76.0,
                    "T4 FAIL (north={north}, spd={speed}): ran off the walkable lip (min_z={min_z:.2}, should hold near 80)"
                );
            }
        }
    }

    // ── REAL Holtburg T4: LB 0xADB1 terrain (dumped from retail client_cell_1.dat
    //    + region LandHeightTable) at the exact probe spot (33360, 34098..) running
    //    NORTH off the z=80 lip. This is the faithful in-code twin of
    //    `movement-probe.mjs T4` — the synthetic clean-lip case above HOLDS, but
    //    the real irregular grid + real landblock split reproduces the run-off. ──
    //
    // h[vx*9+vy], from `holtburger-dat` test `dump_adb1_heights`. At the mover's
    // column vx=6: flat 80 for vy1..5 then a 54.8° drop to 46 (vy6), 40, 34.
    #[rustfmt::skip]
    const ADB1_HEIGHTS: [f32; 81] = [
        58.0,60.0,62.0,52.0,46.0,42.0,38.0,36.0,34.0,
        60.0,62.0,62.0,66.0,50.0,44.0,40.0,36.0,34.0,
        62.0,62.0,66.0,66.0,66.0,46.0,40.0,36.0,34.0,
        72.0,70.0,70.0,70.0,70.0,70.0,42.0,38.0,34.0,
        80.0,74.0,74.0,74.0,74.0,74.0,44.0,38.0,34.0,
        84.0,78.0,78.0,78.0,78.0,78.0,46.0,40.0,34.0,
        88.0,80.0,80.0,80.0,80.0,80.0,46.0,40.0,34.0,
        90.0,78.0,78.0,78.0,78.0,78.0,44.0,38.0,34.0,
        92.0,74.0,74.0,74.0,74.0,74.0,44.0,38.0,32.0,
    ];
    const ADB1: u32 = 0xADB1_0000;
    const ADB1_OX: f32 = 173.0 * 192.0; // blockX 0xAD
    const ADB1_OY: f32 = 177.0 * 192.0; // blockY 0xB1

    fn adb1_pose(wx: f32, wy: f32, wz: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(ADB1),
            coords: v(wx - ADB1_OX, wy - ADB1_OY, wz),
            rotation: Quaternion::identity(),
        }
    }

    /// Faithful live-slice loop over the REAL LB 0xADB1 terrain, running NORTH
    /// from the probe's T4 spot. Returns `(min_z, max_dy, grounded_frac, pose)`.
    fn adb1_t4_walk(retail_ground: bool, frames: usize, speed: f32) -> (f32, f32, f32, WorldPosition) {
        let mut scene = SpatialScene::new();
        scene.populate_terrain_heights(ADB1, ADB1_HEIGHTS);
        let env = DriftEnv { scene };
        // Probe start: world (33360, 34098), z≈80 (the top, 6 m S of the lip@34104).
        let mut pose = adb1_pose(33360.0, 34098.0, 80.0);
        let y0 = 34098.0f32;
        let dt = 1.0 / 30.0f32;
        let dir = v(0.0, speed, 0.0);
        let mut is_airborne = false;
        let mut vvel = 0.0f32;
        let mut planar = dir;
        let mut last_cp: Option<(Plane, u32)> = None;
        let mut gg = gates();
        gg.retail_ground = retail_ground;

        let mut min_z = 80.0f32;
        let mut max_dy = 0.0f32;
        let mut grounded_frames = 0usize;
        for frame in 0..frames {
            let g = pose.global_coords();
            let dz = if is_airborne {
                let az = -9.8f32;
                let d = vvel * dt + 0.5 * az * dt * dt;
                vvel += az * dt;
                d
            } else {
                planar = dir;
                -SINK
            };
            let descending = if is_airborne { vvel <= 0.0 } else { true };
            let end = adb1_pose(g.x + planar.x * dt, g.y + planar.y * dt, g.z + dz);
            let input = TransitionInput {
                begin: pose,
                end,
                object: player(),
                airborne: is_airborne,
                descending,
                force_grounded: false,
                gates: gg,
                last_known_wall_normal: None,
                frames_stationary_fall: 0,
                last_contact_plane: last_cp,
            };
            let out = faithful_find_transitional_position(&env, &input, true, true);
            last_cp = out.contact_plane;
            if !is_airborne && !out.grounded {
                is_airborne = true;
                vvel = 0.0;
            } else if is_airborne && out.grounded {
                is_airborne = false;
                vvel = 0.0;
            }
            pose = out.pose;
            if out.grounded {
                grounded_frames += 1;
            }
            let gp = pose.global_coords();
            if gp.z < min_z {
                min_z = gp.z;
            }
            let dy = gp.y - y0;
            if dy > max_dy {
                max_dy = dy;
            }
            if std::env::var("LIP_DBG").is_ok() && (22..32).contains(&frame) {
                eprintln!(
                    "[adb1 rg={retail_ground}] f{frame}: xy=({:.2},{:.2}) z={:.2} grounded={} air={} state={:?} cp={}",
                    gp.x, gp.y, gp.z, out.grounded, is_airborne, out.state,
                    out.contact_plane.map(|p| p.0.normal.z).unwrap_or(-9.0)
                );
            }
        }
        (min_z, max_dy, grounded_frames as f32 / frames as f32, pose)
    }

    #[test]
    fn outdoor_lip_holtburg_t4_real_holds() {
        // ~7 m/s run (probe measured dy≈27.7 over 4 s), 4 s @ 30 fps ≈ 120 frames.
        let (min_z, max_dy, frac, pose) = adb1_t4_walk(true, 120, 7.0);
        eprintln!(
            "[adb1 T4] min_z={min_z:.2} max_dy={max_dy:.2} grounded_frac={frac:.2} final=({:.2},{:.2},{:.2})",
            pose.global_coords().x, pose.global_coords().y, pose.global_coords().z
        );
        // Acceptance (matches the probe bar): HOLD at the lip — no plunge down the
        // 54.8° face (a plunge reaches z≈46, dz≈−34, like the live T4 failure).
        // The fixed mover holds at z=80; 76 leaves margin while still catching any
        // real run-off down the face.
        assert!(
            min_z > 76.0,
            "T4 FAIL: ran off the real Holtburg lip (min_z={min_z:.2}, dy={max_dy:.2}) — should hold near 80"
        );
    }

    // T2 REGRESSION GUARD (paired with the T4 fix): a mover STANDING on the 54.8°
    // face (mid-slope, y=34116 z≈63) with a STALE WALKABLE carried contact plane
    // (it just teleported/stepped off walkable ground) must SLIDE DOWN under
    // gravity — the walkable-lip edge-hold must NOT stick it. This is exactly the
    // shape that the first (heuristic) fix regressed: the stale walkable plane made
    // `entry_walkable_contact` Some, and a no-drop-only gate then froze the mover
    // in a feedback loop. The `edge_held` driver latch fixes it: a steep-support
    // mover never enters `edge_slide`'s ON_WALKABLE gate, so the latch stays off.
    #[test]
    fn outdoor_mid_slope_idle_slides_not_stuck() {
        let mut scene = SpatialScene::new();
        scene.populate_terrain_heights(ADB1, ADB1_HEIGHTS);
        let env = DriftEnv { scene };
        // Mid-face: y_local=132 (y=34116), x_local=144 — the T2 probe spot.
        let mut pose = adb1_pose(33360.0, 34116.0, 64.0);
        let dt = 1.0 / 30.0f32;
        // STALE walkable plane carried in (mover just left walkable ground): (0,0,1).
        let mut last_cp: Option<(Plane, u32)> =
            Some((Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 }, ADB1 | 0x2e));
        let mut gg = gates();
        gg.retail_ground = true;
        let mut is_airborne = false;
        let mut vvel = 0.0f32;
        let z0 = 64.0f32;
        let mut min_z = z0;
        let mut grounded_frames = 0usize;
        for _frame in 0..90 {
            let g = pose.global_coords();
            let dz = if is_airborne {
                let d = vvel * dt + 0.5 * (-9.8) * dt * dt;
                vvel += -9.8 * dt;
                d
            } else {
                -SINK
            };
            let descending = if is_airborne { vvel <= 0.0 } else { true };
            let end = adb1_pose(g.x, g.y, g.z + dz); // idle: NO forward input
            let input = TransitionInput {
                begin: pose,
                end,
                object: player(),
                airborne: is_airborne,
                descending,
                force_grounded: false,
                gates: gg,
                last_known_wall_normal: None,
                frames_stationary_fall: 0,
                last_contact_plane: last_cp,
            };
            let out = faithful_find_transitional_position(&env, &input, true, true);
            last_cp = out.contact_plane;
            if out.grounded {
                grounded_frames += 1;
            }
            if !is_airborne && !out.grounded {
                is_airborne = true;
                vvel = 0.0;
            } else if is_airborne && out.grounded {
                is_airborne = false;
                vvel = 0.0;
            }
            pose = out.pose;
            if pose.global_coords().z < min_z {
                min_z = pose.global_coords().z;
            }
        }
        let grounded_frac = grounded_frames as f32 / 90.0;
        eprintln!(
            "[adb1 T2] z0={z0} min_z={min_z:.2} final_z={:.2} grounded_frac={grounded_frac:.2}",
            pose.global_coords().z
        );
        // The mover must NOT be edge-held (frozen grounded) on the too-steep face:
        // it stays UNGROUNDED (grounded_frac ≈ 0), knowing it is on a slide surface.
        // Before the `begin_on_walkable` discriminator, the walkable-lip edge-hold
        // froze it grounded at z0 (grounded_frac ≈ 1). The full fall-line descent is
        // driven by the live loop's `calc_friction` (Sledding), which lives in
        // holtburger-core and is out of scope for this world-crate model — so this
        // pins the grounded latch, not the slide distance (the live probe validates
        // the metres); it still leaves the start height (settles onto the face).
        assert!(
            grounded_frac < 0.1,
            "T2 FAIL: edge-held on the mid-slope (grounded_frac={grounded_frac:.2}) — a too-steep \
             support must stay UNGROUNDED so the mover slides, not stick"
        );
        assert!(
            min_z < z0 - 0.5,
            "T2 FAIL: frozen at the top (min_z={min_z:.2}, z0={z0}) — should settle/slide down the face"
        );
    }

    // ── Phase D / WS4: OUTDOOR faithful dispatch FLIP (the public-entry A/B) ────
    //
    // The WS3 tests above drive the driver directly (`outdoor_raw_drive`); these
    // exercise the FLIP itself — `faithful_find_transitional_position` with the
    // outdoor flag ON routes an outdoor pose through the faithful terrain driver
    // (outdoor cell ring + per-cell terrain `find_collisions`), and with the flag
    // OFF rolls back to the heightfield path. The env supplies a flat
    // `terrain_height_at` so the OFF (heightfield) arm grounds — the A/B baseline.

    /// An outdoor [`TransitionEnv`] over a resident-terrain scene with a flat
    /// `terrain_height_at` (so the flag-OFF heightfield path has a floor to snap
    /// to). The faithful ON path reads the scene's terrain heights, not this.
    struct OutdoorEnv {
        scene: SpatialScene,
        ground_z: f32,
    }

    impl TransitionEnv for OutdoorEnv {
        fn scene(&self) -> &SpatialScene {
            &self.scene
        }
        fn terrain_height_at(&self, _x: f32, _y: f32) -> Option<f32> {
            Some(self.ground_z)
        }
        fn terrain_normal_at(&self, _x: f32, _y: f32) -> Option<Vector3> {
            Some(v(0.0, 0.0, 1.0))
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

    // FLAG A/B: a flat outdoor walk through the public entry stays grounded with
    // the outdoor flag ON (faithful terrain driver), 0 fall-through, and the
    // settled height matches the flag-OFF heightfield path within tolerance; the
    // flag-OFF arm uses the heightfield (the rollback regression guard).
    #[test]
    fn outdoor_faithful_dispatch_grounded_flag_ab() {
        const Z: f32 = 50.0;
        let (sx, sy) = outdoor_cell_center(4, 4); // (492, 684)
        let begin = outdoor_pose(sx, sy, Z);
        // Walk +x ~8 within the landblock, dipping below the surface (a gravity
        // stand-in) — the terrain must hold the feet at the surface.
        let end = outdoor_pose(sx + 8.0, sy, Z - 0.15);
        let input = input_for(begin, end);
        let env = OutdoorEnv { scene: outdoor_scene([Z; 81]), ground_z: Z };

        // Flag ON (default) → faithful terrain driver.
        let on = faithful_find_transitional_position(&env, &input, true, true);
        // Flag OFF → heightfield path (the rollback regression guard).
        let off = faithful_find_transitional_position(&env, &input, false, true);

        eprintln!(
            "[ws4-outdoor-ab] ON pose=({:.3},{:.3},{:.3}) grounded={} | OFF pose=({:.3},{:.3},{:.3}) grounded={}",
            on.pose.coords.x, on.pose.coords.y, on.pose.coords.z, on.grounded,
            off.pose.coords.x, off.pose.coords.y, off.pose.coords.z, off.grounded
        );

        // ON: faithful path grounds, advances east, and does NOT fall through the
        // terrain (feet at/above the surface, within a radius of it).
        assert!(on.grounded, "faithful outdoor walk stays grounded (ON_WALKABLE)");
        assert!(
            on.pose.global_coords().x > begin.global_coords().x + 0.5,
            "faithful mover advanced east: {} vs {}",
            on.pose.global_coords().x,
            begin.global_coords().x
        );
        assert!(
            on.pose.coords.z > Z - player().radius,
            "no fall-through: feet z {} stays at/above terrain {Z}",
            on.pose.coords.z
        );
        assert!(
            (on.pose.coords.z - Z).abs() < player().radius,
            "faithful feet track terrain height {Z}: got {}",
            on.pose.coords.z
        );

        // OFF: the heightfield path grounds at the terrain height (regression guard)…
        assert!(off.grounded, "flag-off heightfield path grounds");
        // … and the ON (faithful) settled height matches it within tolerance.
        assert!(
            (on.pose.coords.z - off.pose.coords.z).abs() < player().radius,
            "ON height {} matches heightfield OFF {} within tolerance",
            on.pose.coords.z,
            off.pose.coords.z
        );
    }

    // ── Phase D / WS7: Option C — the off-center-building overlap fix ──────────
    //
    // An off-center BUILDING/static: its physics geometry (a west-facing wall) sits
    // at world x=500, which is inside land cell (4,4) [x∈480..504], but its FOOTPRINT
    // AABB centre is x=512 → its HOME cell is (5,4) [x∈504..528]. So the building is
    // "placed in cell (5,4)" but overruns west into cell (4,4) — exactly the
    // off-center placement Vanquish420 had to force-snap to cell centre to avoid the
    // retail walk-through. The bake's job: with overlap ON, register the building
    // into BOTH cells (so it's testable from the neighbor (4,4)); with overlap OFF,
    // into the home cell (5,4) ONLY (the retail home-cell-only bug).

    /// The off-center building/static, framed to WORLD directly (origin 0 / identity
    /// orientation, so cell-local == world and [`CellPhysicsBsp::world_aabb`] bounds
    /// the real world vertices). Two polys:
    ///   1. the west WALL (the blocker) at world x=500, facing −X (same winding as
    ///      `static_wall_bsp` ⇒ a +x mover stops), y∈[678,690], z∈[40,60];
    ///   2. a ROOF at z=60 spanning x∈[500,524] purely to push the footprint AABB
    ///      centre east into cell (5,4) — 8 m above the capsule head, never collides.
    /// World AABB ⇒ x∈[500,524] (overlaps land cells (4,4) and (5,4)), centre x=512
    /// (home cell (5,4)).
    fn off_center_building_bsp() -> CellPhysicsBsp {
        let mut polys = HashMap::new();
        polys.insert(
            1u16,
            poly(vec![
                v(500.0, 678.0, 40.0),
                v(500.0, 678.0, 60.0),
                v(500.0, 690.0, 60.0),
                v(500.0, 690.0, 40.0),
            ]),
        );
        polys.insert(
            2u16,
            poly(vec![
                v(500.0, 678.0, 60.0),
                v(524.0, 678.0, 60.0),
                v(524.0, 690.0, 60.0),
                v(500.0, 690.0, 60.0),
            ]),
        );
        CellPhysicsBsp {
            tree: one_leaf(&polys),
            polys,
            origin: Vector3::zero(),
            orientation: Quaternion::identity(),
            scale: 1.0,
        }
    }

    // Land cell ids (low word = cell_y + 8*cell_x + 1, matching `lcoord_to_cellid`).
    const CELL_44: u32 = OLB | (4 * 8 + 4 + 1); // 0x0203_0025 — the player's approach cell
    const CELL_54: u32 = OLB | (5 * 8 + 4 + 1); // 0x0203_002D — the building's home cell

    // (a) INDEX proof: with overlap ON the off-center building is present in BOTH
    // its home cell (5,4) AND the overrun neighbor cell (4,4); with overlap OFF it
    // is present in its home cell (5,4) ONLY (the exact retail home-cell registration).
    #[test]
    fn off_center_building_overlap_index_ab() {
        let aabb = off_center_building_bsp().world_aabb();
        let c = aabb.center();
        eprintln!(
            "[opt-c-index] aabb x[{:.1}..{:.1}] y[{:.1}..{:.1}] centre=({:.1},{:.1}) home_cell={:#x}",
            aabb.min.x, aabb.max.x, aabb.min.y, aabb.max.y, c.x, c.y, CELL_54
        );
        // The AABB straddles two land cells (its centre is in (5,4)).
        assert!((aabb.min.x / 24.0).floor() as i32 == 20, "AABB min in global cell 20 (4,4)");
        assert!((aabb.max.x / 24.0).floor() as i32 == 21, "AABB max in global cell 21 (5,4)");
        assert_eq!((c.x / 24.0).floor() as i32, 21, "AABB centre cell is (5,4)");

        // Overlap ON (default = the fix): registered into both overlapped cells.
        let mut on = outdoor_scene([50.0; 81]);
        on.insert_static_physics_bsp(OLB, off_center_building_bsp());
        let n_on = on.bake_outdoor_static_overlap_for_landblock(OLB, true);
        assert_eq!(n_on, 2, "overlap ON registers into both overlapped land cells");
        assert_eq!(on.cell_static_physics_bsp(CELL_54).len(), 1, "ON: home cell (5,4) has the building");
        assert_eq!(
            on.cell_static_physics_bsp(CELL_44).len(),
            1,
            "ON: overrun NEIGHBOR cell (4,4) ALSO has the building (the fix)"
        );

        // Overlap OFF (retail bug repro): home cell (5,4) ONLY.
        let mut off = outdoor_scene([50.0; 81]);
        off.insert_static_physics_bsp(OLB, off_center_building_bsp());
        let n_off = off.bake_outdoor_static_overlap_for_landblock(OLB, false);
        assert_eq!(n_off, 1, "overlap OFF registers into the home cell only");
        assert_eq!(off.cell_static_physics_bsp(CELL_54).len(), 1, "OFF: home cell (5,4) has the building");
        assert_eq!(
            off.cell_static_physics_bsp(CELL_44).len(),
            0,
            "OFF: neighbor cell (4,4) is EMPTY (retail home-cell-only bug)"
        );

        // Bake is idempotent (a re-bake does not double-register).
        let n_on2 = on.bake_outdoor_static_overlap_for_landblock(OLB, true);
        assert_eq!(n_on2, 2, "re-bake registers the same count (idempotent)");
        assert_eq!(on.cell_static_physics_bsp(CELL_44).len(), 1, "re-bake did not double-register");
    }

    // (b) DRIFT A/B proof (the headline): a player approaching the off-center
    // building FROM THE NEIGHBOR CELL (4,4) STOPS at the wall with overlap ON and
    // WALKS THROUGH with overlap OFF — driven through the full faithful outdoor
    // driver (terrain ring + per-cell `find_obj_collisions`). Both stop x's printed.
    #[test]
    fn off_center_building_drift_ab_stop_vs_walkthrough() {
        let (sx, sy) = outdoor_cell_center(4, 4); // (492, 684) — neighbor-cell start
        let wall_x = 500.0_f32; // world x of the building's west wall
        let begin = outdoor_pose(sx, sy, 50.0);
        let end = outdoor_pose(sx + 14.0, sy, 50.0 - 0.15); // walk +x: 492 → 506 (into 5,4)
        let r = player().radius;

        // ON: overlap registers the building into cell (4,4) → the mover STOPS.
        let mut scene_on = outdoor_scene([50.0; 81]);
        scene_on.insert_static_physics_bsp(OLB, off_center_building_bsp());
        scene_on.bake_outdoor_static_overlap_for_landblock(OLB, true);
        let (t_on, found_on) = outdoor_raw_drive(&scene_on, &begin, &end, &player());
        let (feet_on, _) = settled(&t_on);

        // OFF: overlap registers into the home cell (5,4) ONLY → the mover WALKS
        // THROUGH the overrun wall from the neighbor cell (the retail bug).
        let mut scene_off = outdoor_scene([50.0; 81]);
        scene_off.insert_static_physics_bsp(OLB, off_center_building_bsp());
        scene_off.bake_outdoor_static_overlap_for_landblock(OLB, false);
        let (t_off, found_off) = outdoor_raw_drive(&scene_off, &begin, &end, &player());
        let (feet_off, _) = settled(&t_off);

        eprintln!(
            "[opt-c-drift] wall_x={wall_x:.1}  OVERLAP-ON stop x={:.4} (found={found_on})  OVERLAP-OFF stop x={:.4} (found={found_off})  end_x={:.1}",
            feet_on.x, feet_off.x, end.global_coords().x
        );

        // ON: stopped at / just short of the wall face (within one sphere radius).
        assert!(
            feet_on.x <= wall_x + r + 1e-2,
            "overlap ON: mover should STOP at the off-center building wall (x={} wall_x={wall_x})",
            feet_on.x
        );
        // OFF: walked clean through, well east of the wall (the bug).
        assert!(
            feet_off.x > wall_x + 1.0,
            "overlap OFF: mover should WALK THROUGH the off-center building (x={} wall_x={wall_x})",
            feet_off.x
        );
        // The proof pair: overlap ON stops strictly short of where overlap OFF reached.
        assert!(
            feet_off.x > feet_on.x + 0.5,
            "Option C proof: overlap ON ({}) must stop short of overlap OFF ({})",
            feet_on.x,
            feet_off.x
        );
    }
}

// ─── WS1 tests: Landscape + LandDefsSeam for SpatialScene ────────────────────
#[cfg(test)]
mod ws1_outdoor_seam {
    use crate::spatial::scene::SpatialScene;
    use holtburger_common::{Sphere, Vector3};
    use holtburger_dat::transition::objcell::{
        add_all_outside_cells_sphere, gid_to_lcoord, lcoord_to_cellid, Landscape, LandDefsSeam,
    };
    use holtburger_dat::transition::types::{CellArray, Position};
    use std::collections::HashSet;

    /// Landblock `0x1010` (blockX=0x10, blockY=0x10) → the high-word terrain key.
    const LB_KEY: u32 = 0x1010_0000;

    fn flat_scene() -> SpatialScene {
        let mut scene = SpatialScene::new();
        scene.populate_terrain_heights(LB_KEY, [0.0f32; 81]);
        assert_eq!(scene.terrain_heights_count(), 1);
        scene
    }

    fn sphere_at(x: f32, y: f32, r: f32) -> Sphere {
        Sphere { center: Vector3::new(x, y, 0.0), radius: r }
    }

    // 1) A sphere near a cell's +x/+y corner floods the 3 corner neighbours
    //    (center + +x + +y + diagonal) through the REAL scene seams.
    #[test]
    fn outdoor_ring_floods_corner_neighbors() {
        let scene = flat_scene();
        // In-block cell (cellX=3, cellY=3) → low word 1 + 8*3 + 3 = 28 (0x1C).
        let player_cell = 0x1010_001Cu32;
        // Block-local centre near the cell's +x/+y corner (cell footprint
        // [72,96)×[72,96); radius 1.0 → within 1.0 of both edges).
        let p = Position { objcell_id: player_cell, ..Default::default() };
        let mut ca = CellArray::default();
        add_all_outside_cells_sphere(
            &mut ca,
            &scene,
            &scene,
            &p,
            1,
            &[sphere_at(95.5, 95.5, 1.0)],
        );

        let ids: HashSet<u32> = ca.cells.iter().map(|c| c.cell_id).collect();
        let expect: HashSet<u32> = [
            lcoord_to_cellid(131, 131), // center  → 0x1010_001C
            lcoord_to_cellid(132, 131), // +x      → 0x1010_0024
            lcoord_to_cellid(132, 132), // +x/+y   → 0x1010_0025
            lcoord_to_cellid(131, 132), // +y      → 0x1010_001D
        ]
        .into_iter()
        .collect();
        assert_eq!(ids, expect, "corner sphere floods center + 3 neighbours");
        assert_eq!(ca.num_cells, 4);
        // All four cells are in the resident landblock → real handles attached.
        for c in &ca.cells {
            assert!(c.cell.is_some(), "resident cell {:#010x} got a handle", c.cell_id);
            assert_eq!(c.cell.as_ref().unwrap().id(), c.cell_id);
        }
    }

    // A sphere dead-centre in a cell pulls in ONLY that cell (no ring).
    #[test]
    fn outdoor_ring_center_only() {
        let scene = flat_scene();
        let p = Position { objcell_id: 0x1010_001C, ..Default::default() };
        let mut ca = CellArray::default();
        // Cell (3,3) footprint centre = (72+12, 72+12) = (84, 84).
        add_all_outside_cells_sphere(&mut ca, &scene, &scene, &p, 1, &[sphere_at(84.0, 84.0, 1.0)]);
        assert_eq!(ca.num_cells, 1);
        assert_eq!(ca.cells[0].cell_id, lcoord_to_cellid(131, 131));
    }

    // 2) adjust_to_outside round-trips a known outdoor position to its lcoord.
    #[test]
    fn adjust_to_outside_roundtrips_outdoor_position() {
        let scene = SpatialScene::new();
        // Landblock (blockX=10, blockY=20) → high word ((10<<8)|20)<<16 = 0x0A14_0000.
        // In-block cell (cellX=3, cellY=5) → low word 1 + 8*3 + 5 = 30 (0x1E).
        let cell_id = 0x0A14_001Eu32;
        // Block-local centre of that cell: (3*24+12, 5*24+12) = (84, 132).
        let mut loc = Vector3::new(84.0, 132.0, 5.0);
        let out = scene
            .adjust_to_outside(cell_id, &mut loc)
            .expect("in-range outdoor cell adjusts");
        // Already block-local → maps back to the same cell, loc unchanged (z too).
        assert_eq!(out, cell_id);
        assert_eq!(gid_to_lcoord(out), Some((83, 165)));
        assert!((loc.x - 84.0).abs() < 1e-4);
        assert!((loc.y - 132.0).abs() < 1e-4);
        assert!((loc.z - 5.0).abs() < 1e-4);
    }

    // A point that spilled past the +x landblock edge snaps into the NEXT
    // landblock and rewrites loc to that block's local [0,192) frame.
    #[test]
    fn adjust_to_outside_crosses_landblock_edge() {
        let scene = SpatialScene::new();
        let cell_id = 0x0A14_001Eu32; // block (10,20), corner lcoord (80,160)
        let mut loc = Vector3::new(200.0, 132.0, 0.0); // x spills into block 11
        let out = scene.adjust_to_outside(cell_id, &mut loc).unwrap();
        // floor(200/24)=8 → global lcoord (88,165) → landblock 11 (blockX=11).
        assert_eq!(gid_to_lcoord(out), Some((88, 165)));
        assert_eq!(out >> 16, 0x0B14); // landblock high word advanced in X
        assert!((loc.x - 8.0).abs() < 1e-4, "loc.x wrapped to new block-local");
        assert!((loc.y - 132.0).abs() < 1e-4);
    }

    // The EPSILON pre-snap zeroes a near-zero in-block coord.
    #[test]
    fn adjust_to_outside_epsilon_snaps_near_zero() {
        let scene = SpatialScene::new();
        let cell_id = 0x0A14_001Eu32;
        let mut loc = Vector3::new(0.0001, 0.0001, 0.0); // < EPSILON (0.0002)
        let out = scene.adjust_to_outside(cell_id, &mut loc).unwrap();
        // Snapped to (0,0) → block corner cell (lcoord (80,160), low word 1).
        assert_eq!(gid_to_lcoord(out), Some((80, 160)));
        assert_eq!(loc.x, 0.0);
        assert_eq!(loc.y, 0.0);
    }

    // 3) get_landcell: indoor / out-of-range / non-resident → None; resident
    //    outdoor cell → Some with the right id.
    #[test]
    fn get_landcell_rejects_indoor_and_nonresident() {
        let mut scene = SpatialScene::new();
        // Not resident yet → None even for a valid outdoor cell id.
        assert!(scene.get_landcell(0x1010_0001).is_none());

        scene.populate_terrain_heights(LB_KEY, [0.0f32; 81]);
        // Resident outdoor cell → handle with the queried id.
        let h = scene.get_landcell(0x1010_0001).expect("resident outdoor cell");
        assert_eq!(h.id(), 0x1010_0001);

        // Interior id (low u16 = 0x0101 ≥ 0x100) → None even with LB resident.
        assert!(scene.get_landcell(0x1010_0101).is_none());
        // A different, non-resident landblock → None.
        assert!(scene.get_landcell(0x2020_0001).is_none());
    }

    // adjust_to_outside rejects an in-block cell id outside the wrappable set.
    #[test]
    fn adjust_to_outside_rejects_out_of_range_cell() {
        let scene = SpatialScene::new();
        // Low word 0 is not a land (1..=64), structure (0xFFFF) or env
        // (0x100..=0xFFFD) cell → cell_in_range false → None.
        let mut loc = Vector3::new(12.0, 12.0, 0.0);
        assert!(scene.adjust_to_outside(0x1010_0000, &mut loc).is_none());
    }
}
