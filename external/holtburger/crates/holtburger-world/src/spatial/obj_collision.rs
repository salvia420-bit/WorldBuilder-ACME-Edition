//! Doors, creatures and players collided INSIDE the faithful transition —
//! retail `CObjCell::find_obj_collisions` → `CPhysicsObj::FindObjCollisions`
//! → `CPartArray::FindObjCollisions` / `CCylSphere::intersects_sphere` /
//! `CSphere::intersects_sphere`.
//!
//! Before this module the faithful driver collided only cell geometry and
//! baked statics; dynamic objects were clamped AFTER the transition
//! (`clamp_delta_against_entities`, an XY-only residual correction in
//! `holtburger-core`'s `finish_manual_slice_via_transition`), so a door leaf
//! or an NPC could never slide the mover, step it up, give it a contact
//! plane, or reject a placement.
//!
//! ## Retail call chain (all read in `~/ac-headers/acclient.c`)
//! * `CEnvCell::find_collisions` (347810) / `CLandCell::find_collisions`
//!   (354887): environment (terrain → building) first, then
//!   `CObjCell::find_obj_collisions` (347142): skipped for
//!   `insert_type == INITIAL_PLACEMENT`; every SHADOW object of the cell that
//!   is not parented and is not the mover, first non-OK result wins.
//! * Objects reach a cell's shadow list through `add_obj_to_cell` (322897) →
//!   `calc_cross_cells_static` (322405) / `calc_cross_cells` (322447) →
//!   `add_shadows_to_cells` (321978): the object is listed in EVERY cell its
//!   collision volume crosses (`find_cell_list` over its cylspheres / sorting
//!   sphere, or `find_bbox_cell_list` (318276) for a BSP object) — a door in
//!   a doorway sits in both the EnvCell and the landcell. [`ObjOverlay`]
//!   reproduces that per transition (see [`build_obj_overlay`]).
//! * `CPhysicsObj::FindObjCollisions` (316159-316290) — [`find_obj_collisions`].
//! * `CSphere::intersects_sphere` (outer 359390, inner 359157) and its
//!   responses `step_sphere_up` (359072), `slide_sphere` (358709 / 359139 →
//!   358899), `land_on_sphere` (359115), `collide_with_point` (358808),
//!   `step_sphere_down` (358616).
//! * `CCylSphere::intersects_sphere` (outer 362244, inner 362035) and
//!   `collides_with_sphere` (361502), `step_sphere_down` (361574),
//!   `normal_of_collision` (361652), `collide_with_point` (361705),
//!   `slide_sphere` (361957), `step_sphere_up` (361976),
//!   `land_on_cylinder` (362015).
//!
//! Cross-checked against ACE `Physics/PhysicsObj.cs` (`FindObjCollisions`),
//! `Physics/Sphere.cs` and `Physics/CylSphere.cs`, which are straight
//! translations; where the decomp lost an x87 compare (358786) ACE's form is
//! used and noted.
//!
//! Gated by [`obj_collide_in_transition_enabled`] (default OFF; thread-local,
//! so `cargo test` threads cannot race each other).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Weak};

use holtburger_common::{Plane, Quaternion, Sphere, Triangle, Vector3};
use holtburger_dat::physics::{BspLeaf, BspNode, ResolvedPolygon};
use holtburger_dat::transition::frame_transform::Frame;
use holtburger_dat::transition::objcell::{find_cell_list, CellWorld};
use holtburger_dat::transition::sphere_collide_point::{self, CollideWithPoint};
use holtburger_dat::transition::sphere_slide::{self, SlideSphere};
use holtburger_dat::transition::sphere_step::{self, StepSphereDown, StepSphereUp};
use holtburger_dat::transition::types::{
    normalize_check_small, object_info_state as ois, CTransition, CellArray, InsertType,
    LandDefs, Position, EPSILON, Z_FOR_LANDING,
};

use super::scenery::{
    cylsphere_collides_with_sphere, cylsphere_normal_of_collision, SetupCylSphere, WorldCylSphere,
};

// ─── the runtime switch ──────────────────────────────────────────────────────

thread_local! {
    static OBJ_COLLIDE_IN_TRANSITION: Cell<bool> = const { Cell::new(false) };
}

/// `?objCollideInTransition` — collide doors / creatures / players INSIDE the
/// faithful transition (this module). Default OFF. When ON, the movement
/// system drops its post-transition `clamp_delta_against_entities` and the
/// door-stopgap cell relabel.
pub fn obj_collide_in_transition_enabled() -> bool {
    OBJ_COLLIDE_IN_TRANSITION.with(|c| c.get())
}

/// Set the switch for this thread (wasm is single-threaded; each `cargo test`
/// runs on its own thread).
pub fn set_obj_collide_in_transition(on: bool) {
    OBJ_COLLIDE_IN_TRANSITION.with(|c| c.set(on));
}

// ─── object data ─────────────────────────────────────────────────────────────

/// `PhysicsState` bits `FindObjCollisions` reads (acclient.h `PhysicsState`).
pub mod physics_state {
    pub const STATIC: u32 = 0x1;
    pub const ETHEREAL: u32 = 0x4;
    pub const IGNORE_COLLISIONS: u32 = 0x10;
    pub const MISSILE: u32 = 0x40;
    pub const HAS_PHYSICS_BSP: u32 = 0x1_0000;
}

/// The `CWeenieObject` predicates `FindObjCollisions` calls through the
/// vtable (316214-316225), as the client answers them
/// (`ACCWeenieObject::IsPlayer` 437199 `pwd._bitfield >> 3`, `IsPK` 437211
/// `>> 5`, `IsImpenetrable` 437217 `>> 21`, `IsPKLite` 437205 `>> 25`,
/// `IsCreature` 436879 `item_type & TYPE_CREATURE`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WeenieTraits {
    pub is_player: bool,
    pub is_creature: bool,
    pub is_impenetrable: bool,
    pub is_pk: bool,
    pub is_pklite: bool,
}

/// A SetupModel's collision primitives (`CSetup.cylsphere` / `.sphere`),
/// setup-local and unscaled — what `CPartArray::GetCylsphere` / `GetSphere`
/// hand `FindObjCollisions`.
#[derive(Debug, Clone, Default)]
pub struct SetupCollisionShapes {
    pub cylspheres: Vec<SetupCylSphere>,
    pub spheres: Vec<Sphere>,
}

/// An object's physics BSP as the transition resolver consumes it: one
/// non-solid leaf carrying every physics polygon (setup-local, part frames
/// composed in). The polygons are exact; only the tree's spatial
/// partitioning is flattened, so the resolver tests every polygon.
#[derive(Debug, Clone)]
pub struct ObjPhysicsBsp {
    pub tree: BspNode,
    pub polys: HashMap<u16, ResolvedPolygon>,
}

impl ObjPhysicsBsp {
    pub fn from_triangles(triangles: &[Triangle]) -> Self {
        let mut polys = HashMap::new();
        for (i, tri) in triangles.iter().take(u16::MAX as usize).enumerate() {
            let verts = vec![tri.v0, tri.v1, tri.v2];
            if let Some(plane) = ResolvedPolygon::make_plane(&verts) {
                polys.insert(
                    i as u16,
                    ResolvedPolygon {
                        num_points: 3,
                        vertices: verts,
                        plane,
                    },
                );
            }
        }
        let mut ids: Vec<u16> = polys.keys().copied().collect();
        ids.sort_unstable();
        Self {
            tree: BspNode::Leaf(BspLeaf {
                index: 0,
                solid: 0,
                sphere: None,
                poly_ids: ids,
            }),
            polys,
        }
    }
}

thread_local! {
    /// Per-geometry BSP cache: the geometry `Arc` is shared per SetupModel,
    /// so building the flattened tree once per geometry (not per transition)
    /// keeps the gather cheap. `Weak` guards against address reuse.
    static BSP_CACHE: RefCell<HashMap<usize, (Weak<super::EntityPhysicsGeometry>, Arc<ObjPhysicsBsp>)>> =
        RefCell::new(HashMap::new());
}

/// [`ObjPhysicsBsp`] for an entity's shared physics geometry (cached).
pub fn obj_bsp_for_geometry(geometry: &Arc<super::EntityPhysicsGeometry>) -> Arc<ObjPhysicsBsp> {
    let key = Arc::as_ptr(geometry) as usize;
    BSP_CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if let Some((weak, bsp)) = c.get(&key) {
            if weak.upgrade().is_some_and(|g| Arc::ptr_eq(&g, geometry)) {
                return bsp.clone();
            }
        }
        let bsp = Arc::new(ObjPhysicsBsp::from_triangles(&geometry.triangles));
        c.retain(|_, (w, _)| w.strong_count() > 0);
        c.insert(key, (Arc::downgrade(geometry), bsp.clone()));
        bsp
    })
}

/// One collidable object as `FindObjCollisions` sees it.
#[derive(Debug, Clone)]
pub struct ObjCollider {
    /// `CPhysicsObj::id`.
    pub id: u32,
    /// Live `CPhysicsObj::state` (`PhysicsState` bits) — a door's open/closed
    /// is its `ETHEREAL` bit from the wire, nothing else.
    pub state: u32,
    /// `weenie_obj`; `None` for an object with no weenie.
    pub weenie: Option<WeenieTraits>,
    /// The object's cell (`m_position.objcell_id`) — the seed of its shadow
    /// cell list.
    pub cell_id: u32,
    /// `m_position` origin, WORLD metres.
    pub origin: Vector3,
    /// `m_position` orientation.
    pub orientation: Quaternion,
    /// `m_scale`.
    pub scale: f32,
    /// The part array's physics BSP (only used with `HAS_PHYSICS_BSP`).
    pub bsp: Option<Arc<ObjPhysicsBsp>>,
    /// Bounding radius of `bsp` about the object origin, unscaled.
    pub bsp_bound: f32,
    /// `CPartArray::GetCylsphere`, setup-local, unscaled.
    pub cylspheres: Vec<SetupCylSphere>,
    /// `CPartArray::GetSphere`, setup-local, unscaled.
    pub spheres: Vec<Sphere>,
}

impl ObjCollider {
    /// `m_position` in the driver's WORLD frame.
    pub fn position(&self) -> Position {
        Position {
            objcell_id: self.cell_id,
            frame: super::faithful_bridge::frame_from(self.orientation, self.origin),
        }
    }

    /// The WORLD spheres whose cell crossings make the object's shadow list
    /// (see [`build_obj_overlay`]).
    fn shadow_spheres(&self) -> Vec<Sphere> {
        let frame = self.position().frame;
        let s = self.scale;
        if self.state & physics_state::HAS_PHYSICS_BSP != 0 && self.bsp.is_some() {
            return vec![Sphere {
                center: self.origin,
                radius: self.bsp_bound * s,
            }];
        }
        if !self.cylspheres.is_empty() {
            return self
                .cylspheres
                .iter()
                .map(|c| {
                    // The smallest sphere about the cylinder's mid-point that
                    // ENCLOSES it reaches the rim of a cap: hypot(r, h/2).
                    // (`max(r, h/2)` — the first version — leaves the cap
                    // rims outside, so a cylinder could miss a cell it
                    // crosses.)
                    let mid = Vector3::new(c.origin.x, c.origin.y, c.origin.z + c.height * 0.5) * s;
                    Sphere {
                        center: frame.localtoglobal(mid),
                        radius: c.radius.hypot(c.height * 0.5) * s,
                    }
                })
                .collect();
        }
        self.spheres
            .iter()
            .map(|sp| Sphere {
                center: frame.localtoglobal(sp.center * s),
                radius: sp.radius * s,
            })
            .collect()
    }
}

// ─── shadow lists: the per-transition object overlay ─────────────────────────

/// The objects near a transition, each listed under every cell its collision
/// volume crosses — the client-side stand-in for retail's per-cell shadow
/// object lists (`add_shadows_to_cells`, acclient.c:321978).
#[derive(Debug, Default)]
pub struct ObjOverlay {
    objects: Vec<ObjCollider>,
    by_cell: HashMap<u32, Vec<usize>>,
}

impl ObjOverlay {
    /// The cells `objects[i]` is shadowed into (test/diagnostic surface).
    pub fn cells_of(&self, id: u32) -> Vec<u32> {
        let Some(i) = self.objects.iter().position(|o| o.id == id) else {
            return Vec::new();
        };
        let mut cells: Vec<u32> = self
            .by_cell
            .iter()
            .filter(|(_, v)| v.contains(&i))
            .map(|(&c, _)| c)
            .collect();
        cells.sort_unstable();
        cells
    }
}

/// Build the overlay: every object is listed in the cells retail's
/// `calc_cross_cells` would put its shadows in — `CObjCell::find_cell_list`
/// (346961) seeded from the object's own cell over its collision spheres, so
/// the portal flood, the exterior-portal straddle ring and the outdoor
/// building-portal transit all apply. Approximations (documented): a BSP
/// object uses its bounding sphere about the origin where retail walks the
/// part bounding boxes (`find_bbox_cell_list` 318276 →
/// `find_transit_cells(parts)`), and a cylsphere is enclosed in one sphere.
pub fn build_obj_overlay(world: &dyn CellWorld, objects: Vec<ObjCollider>) -> ObjOverlay {
    let mut by_cell: HashMap<u32, Vec<usize>> = HashMap::new();
    for (i, obj) in objects.iter().enumerate() {
        let spheres = obj.shadow_spheres();
        let mut cells = CellArray::default();
        if obj.cell_id != 0 && !spheres.is_empty() {
            let mut frame = Frame::identity();
            frame.origin = obj.origin;
            let p = Position {
                objcell_id: obj.cell_id,
                frame,
            };
            find_cell_list(world, &p, spheres.len() as u32, &spheres, &mut cells, None, None);
        }
        let mut ids: Vec<u32> = cells.cells.iter().map(|c| c.cell_id).collect();
        if obj.cell_id != 0 {
            ids.push(obj.cell_id);
        }
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            by_cell.entry(id).or_default().push(i);
        }
    }
    ObjOverlay { objects, by_cell }
}

thread_local! {
    static OVERLAY: RefCell<Option<Rc<ObjOverlay>>> = const { RefCell::new(None) };
}

/// RAII: the overlay the faithful driver's cells consult for the duration of
/// one transition (the bridge holds it around `find_valid_position`).
pub struct ObjOverlayGuard(Option<Rc<ObjOverlay>>);

impl ObjOverlayGuard {
    pub fn install(overlay: Rc<ObjOverlay>) -> Self {
        Self(OVERLAY.with(|c| c.replace(Some(overlay))))
    }
}

impl Drop for ObjOverlayGuard {
    fn drop(&mut self) {
        let prev = self.0.take();
        OVERLAY.with(|c| *c.borrow_mut() = prev);
    }
}

/// `CObjCell::find_obj_collisions` (acclient.c:347142) over the dynamic
/// objects shadowed into `cell_id`: skipped for an INITIAL placement insert
/// (`insert_type != 2`, :347151); each object in turn (parented objects and
/// the mover are excluded when the overlay is gathered, :347159); the first
/// non-OK result wins (:347162). OK when no overlay is installed.
pub fn collide_cell_objects(cell_id: u32, t: &mut CTransition) -> i32 {
    if t.sphere_path.insert_type == InsertType::InitialPlacement {
        return 1;
    }
    let Some(overlay) = OVERLAY.with(|c| c.borrow().clone()) else {
        return 1;
    };
    if let Some(list) = overlay.by_cell.get(&cell_id) {
        for &i in list {
            let r = find_obj_collisions(&overlay.objects[i], t);
            if r != 1 {
                return r;
            }
        }
    }
    1
}

// ─── CPhysicsObj::FindObjCollisions ──────────────────────────────────────────

/// `OBJECTINFO::missile_ignore` (acclient.c:314070). The target being a
/// MISSILE is always ignored; the mover-is-a-missile branch needs the
/// mover's own `PhysicsState`, which `OBJECTINFO` here does not carry — the
/// only mover routed through the faithful driver is the local player, which
/// is never a missile.
fn missile_ignore(obj: &ObjCollider) -> bool {
    obj.state & physics_state::MISSILE != 0
}

/// `CPhysicsObj::FindObjCollisions` (acclient.c:316159-316290).
pub fn find_obj_collisions(obj: &ObjCollider, t: &mut CTransition) -> i32 {
    let st = obj.state;
    // 316193-316194: ETHEREAL && IGNORE_COLLISIONS → never tested.
    if st & physics_state::ETHEREAL != 0 && st & physics_state::IGNORE_COLLISIONS != 0 {
        return 1;
    }
    // 316195-316200: a viewer passes through creatures.
    if let Some(w) = obj.weenie {
        if t.object_info.state & ois::IS_VIEWER != 0 && w.is_creature {
            return 1;
        }
    }
    // 316201-316212: ethereal target (or an ethereal mover vs a non-static
    // target) → obstruction_ethereal; during a step-down, OK at once.
    let ethereal = if st & physics_state::ETHEREAL != 0
        || (t.object_info.ethereal && st & physics_state::STATIC == 0)
    {
        if t.sphere_path.step_down {
            return 1;
        }
        true
    } else {
        false
    };
    t.sphere_path.obstruction_ethereal = ethereal;

    // 316214-316225: the player-vs-player exemption. A player mover passes
    // through another (non-impenetrable) player unless both are PK or both
    // PK-lite; an impenetrable mover never passes.
    let os = t.object_info.state;
    let exempt = obj.weenie.is_some_and(|w| {
        w.is_player
            && os & ois::IS_PLAYER != 0
            && os & ois::IS_IMPENETRABLE == 0
            && !w.is_impenetrable
            && !(os & ois::IS_PK != 0 && w.is_pk)
            && !(os & ois::IS_PKLITE != 0 && w.is_pklite)
    });
    // 316227-316228.
    let is_creature = st & physics_state::MISSILE != 0 || obj.weenie.is_some_and(|w| w.is_creature);
    let ignore = missile_ignore(obj);

    let pos = obj.position();
    let mut result = 1;
    // 316229: the BSP only with HAS_PHYSICS_BSP (and a resident part BSP —
    // residency is ours; an object whose geometry has not streamed in falls
    // through to its primitives).
    let use_bsp = st & physics_state::HAS_PHYSICS_BSP != 0 && !exempt && !ignore && obj.bsp.is_some();
    if use_bsp {
        // 316285 → CPartArray::FindObjCollisions (325464) →
        // CPhysicsPart::find_obj_collisions (314656): cache the swept spheres
        // into the part frame at the part scale, then BSPTREE::find_collisions.
        if let Some(bsp) = &obj.bsp {
            t.sphere_path.cache_localspace_sphere(&pos, obj.scale);
            result = holtburger_dat::transition::resolver_find::find_collisions(
                &bsp.tree, t, obj.scale, &bsp.polys,
            );
        }
    } else if !obj.cylspheres.is_empty() && !exempt && !ignore {
        // 316254-316276.
        for c in &obj.cylspheres {
            result = cylsphere_intersects_sphere_at(c, &pos, obj.scale, t);
            if result != 1 {
                break;
            }
        }
    } else if !obj.spheres.is_empty() && !exempt && !ignore {
        // 316235-316252.
        for s in &obj.spheres {
            result = sphere_intersects_sphere_at(s, &pos, obj.scale, t, is_creature);
            if result != 1 {
                break;
            }
        }
    }

    // LABEL_57 (316287-316306).
    if result != 1 && !t.sphere_path.step_down {
        if st & physics_state::STATIC != 0 {
            if os & ois::CONTACT == 0 {
                t.collision_info.collided_with_environment = true;
            }
        } else if ethereal || (is_creature && os & ois::IGNORE_CREATURES != 0) {
            result = 1;
            t.collision_info.collision_normal = None; // collision_normal_valid = 0
            // COLLISIONINFO::add_object(obj, OK) — the collide-object list
            // feeds retail's collision REPORTING, which this client does not
            // model (the server reports collisions).
        }
        // else COLLISIONINFO::add_object(obj, result) — not modelled, see above.
    }
    t.sphere_path.obstruction_ethereal = false;
    result
}

// ─── shared helpers ──────────────────────────────────────────────────────────

/// `path->global_curr_center[n]`. Our `SpherePath` caches only sphere 0's;
/// sphere 1 sits at the same rigid offset from sphere 0 as in
/// `global_sphere` (an identity-oriented, upright capsule).
fn gcc(t: &CTransition, n: usize) -> Vector3 {
    let c0 = t.sphere_path.global_curr_center;
    if n == 0 {
        c0
    } else {
        c0 + (t.sphere_path.global_sphere[1].center - t.sphere_path.global_sphere[0].center)
    }
}

fn collides_with_sphere(disp: Vector3, radsum: f32) -> bool {
    // CSphere::collides_with_sphere (358509), recovered as in sphere_step.rs.
    disp.length_squared() <= radsum * radsum
}

fn block_offset(t: &CTransition) -> Vector3 {
    LandDefs::get_block_offset(t.sphere_path.curr_pos.objcell_id, t.sphere_path.check_pos.objcell_id)
}

fn plane_through(normal: Vector3, point: Vector3) -> Plane {
    Plane {
        normal,
        d: -normal.dot(&point),
    }
}

/// `CSphere::slide_sphere(this = moving sphere, path, collisions, normal,
/// curr_pos)` (acclient.c:358899) — the leaf in `sphere_slide.rs` plus the
/// same side-effect replay as the driver's private copy
/// (`driver_spine.rs::csphere_slide_sphere`).
fn moving_sphere_slide(t: &mut CTransition, moving: Sphere, normal: Vector3, curr_center: Vector3) -> i32 {
    let contact_plane_normal = t
        .collision_info
        .contact_plane
        .or(t.collision_info.last_known_contact_plane)
        .map(|p| p.normal)
        .unwrap_or_else(Vector3::zero);
    match sphere_slide::slide_sphere(moving.center, normal, curr_center, contact_plane_normal, block_offset(t)) {
        SlideSphere::Adjusted { offset } => {
            t.sphere_path.add_offset_to_check_pos(&offset);
            3
        }
        SlideSphere::Slid { offset } => {
            t.collision_info.set_collision_normal(normal);
            t.sphere_path.add_offset_to_check_pos(&offset);
            4
        }
        SlideSphere::Collided { recomputed_normal } => {
            t.collision_info.set_collision_normal(normal);
            if let Some(n) = recomputed_normal {
                t.collision_info.set_collision_normal(n);
            }
            2
        }
    }
}

/// `CTransition::step_up(normal)` then, on failure,
/// `SPHEREPATH::step_up_slide` — the tail both `step_sphere_up`s share
/// (359101-359108 / 362000-362008).
fn step_up_or_slide(t: &mut CTransition, normal: Vector3) -> i32 {
    if t.step_up(&normal) != 0 {
        1
    } else {
        t.sphere_path.step_up_slide(&t.object_info, &mut t.collision_info)
    }
}

// ─── CSphere::intersects_sphere ──────────────────────────────────────────────

/// `CSphere::intersects_sphere(this, Position *p, float scale, CTransition
/// *, int is_creature)` (acclient.c:359390): the setup sphere scaled and
/// placed by the object's position, then the inner test.
pub fn sphere_intersects_sphere_at(
    sphere: &Sphere,
    p: &Position,
    scale: f32,
    t: &mut CTransition,
    is_creature: bool,
) -> i32 {
    let global = Sphere {
        center: p.frame.localtoglobal(sphere.center * scale),
        radius: sphere.radius * scale,
    };
    sphere_intersects_sphere(global, t, is_creature)
}

/// `CSphere::intersects_sphere(this, CTransition *, int is_creature)`
/// (acclient.c:359157). `this` is the obstacle sphere, in the driver frame.
pub fn sphere_intersects_sphere(this: Sphere, t: &mut CTransition, is_creature: bool) -> i32 {
    let g0 = t.sphere_path.global_sphere[0];
    let g1 = t.sphere_path.global_sphere[1];
    let multi = t.sphere_path.num_sphere > 1;
    let mut disp = g0.center - this.center;
    let disp2 = g1.center - this.center;
    let mut radsum = this.radius + g0.radius - EPSILON;

    // 359226-359244: obstruction-ethereal or PLACEMENT — overlap only.
    if t.sphere_path.obstruction_ethereal || t.sphere_path.insert_type == InsertType::Placement {
        if radsum * radsum >= disp.length_squared() {
            return 2;
        }
        if multi {
            return if collides_with_sphere(disp2, radsum) { 2 } else { 1 };
        }
        return 1;
    }
    // 359384-359387: step-down.
    if t.sphere_path.step_down {
        if is_creature {
            return 1;
        }
        return sphere_step_sphere_down(this, t, disp, if multi { Some(disp2) } else { None }, radsum);
    }
    // 359247-359259: check_walkable — overlap only.
    if t.sphere_path.check_walkable {
        if collides_with_sphere(disp, radsum) {
            return 2;
        }
        if multi {
            return if collides_with_sphere(disp2, radsum) { 2 } else { 1 };
        }
        return 1;
    }
    // 359260-359319: not yet collided this step.
    if !t.sphere_path.collide {
        let state = t.object_info.state;
        if state & (ois::CONTACT | ois::ON_WALKABLE) != 0 {
            if collides_with_sphere(disp, radsum) {
                return sphere_step_sphere_up(this, t, disp, radsum);
            }
            if multi && collides_with_sphere(disp2, radsum) {
                // 359268 → slide_sphere(8-arg, sphere_number 1) (359139).
                let c1 = gcc(t, 1);
                let mut n = c1 - this.center;
                if normalize_check_small(&mut n) {
                    return 2;
                }
                return moving_sphere_slide(t, g1, n, c1);
            }
        } else if state & ois::PATH_CLIPPED != 0 {
            if collides_with_sphere(disp, radsum) {
                return sphere_collide_with_point(this, t, g0, radsum, 0);
            }
        } else {
            if collides_with_sphere(disp, radsum) {
                return sphere_land_on_sphere(this, t);
            }
            if multi && collides_with_sphere(disp2, radsum) {
                return sphere_collide_with_point(this, t, g1, radsum, 1);
            }
        }
        return 1;
    }
    // 359321-359322.
    if is_creature {
        return 1;
    }
    // 359323-359380: collided — interpolate onto the sphere's top.
    if collides_with_sphere(disp, radsum) || (multi && collides_with_sphere(disp2, radsum)) {
        let movement0 = gcc(t, 0) - g0.center - block_offset(t);
        radsum += EPSILON;
        let len_sq = movement0.length_squared() as f64;
        let mdotd = movement0.dot(&disp) as f64;
        let diff = -mdotd;
        if len_sq.abs() >= EPSILON as f64 {
            let mut v20 = (diff * diff
                - (disp.length_squared() as f64 - (radsum as f64) * (radsum as f64)) * len_sq)
                .sqrt()
                - mdotd;
            if v20 > 1.0 {
                v20 = diff + diff - v20;
            }
            let time = v20 / len_sq;
            let timecheck = (1.0 - time) * t.sphere_path.walk_interp as f64;
            if timecheck < t.sphere_path.walk_interp as f64 && timecheck >= -0.1 {
                let movement = movement0 * time as f32;
                disp = (disp + movement) / radsum;
                // SPHEREPATH::is_walkable_allowable (358475): z > allowance.
                if disp.z > t.sphere_path.walkable_allowance {
                    let point = g0.center - disp * g0.radius;
                    t.collision_info.set_contact_plane(plane_through(disp, point), true);
                    t.collision_info.contact_plane_cell_id = t.sphere_path.check_pos.objcell_id;
                    t.sphere_path.walk_interp = timecheck as f32;
                    t.sphere_path.add_offset_to_check_pos_with_radius(&movement, g0.radius);
                    return 3;
                }
                return 1;
            }
        }
        return 2;
    }
    1
}

/// `CSphere::step_sphere_down` (acclient.c:358616) — the leaf in
/// `sphere_step.rs` with its side effects replayed.
fn sphere_step_sphere_down(this: Sphere, t: &mut CTransition, disp: Vector3, disp2: Option<Vector3>, radsum: f32) -> i32 {
    match sphere_step::step_sphere_down(
        this,
        disp,
        disp2,
        radsum,
        t.sphere_path.step_down_amt,
        t.sphere_path.walk_interp,
        t.sphere_path.walkable_allowance,
    ) {
        StepSphereDown::Ok => 1,
        StepSphereDown::Collided => 2,
        StepSphereDown::Adjusted {
            contact_plane,
            offset,
            new_walk_interp,
            ..
        } => {
            t.collision_info.set_contact_plane(contact_plane, true);
            t.collision_info.contact_plane_cell_id = t.sphere_path.check_pos.objcell_id;
            t.sphere_path.walk_interp = new_walk_interp;
            let r = t.sphere_path.global_sphere[0].radius;
            t.sphere_path.add_offset_to_check_pos_with_radius(&offset, r);
            3
        }
    }
}

/// `CSphere::step_sphere_up` (acclient.c:359072).
fn sphere_step_sphere_up(this: Sphere, t: &mut CTransition, disp: Vector3, radsum: f32) -> i32 {
    match sphere_step::step_sphere_up(this, gcc(t, 0), disp, t.object_info.step_up_height, radsum) {
        StepSphereUp::Slide { radsum: radsuma } => sphere_slide_7(this, t, disp, radsuma, 0),
        StepSphereUp::StepUp { collision_normal } => step_up_or_slide(t, collision_normal),
    }
}

/// `CSphere::slide_sphere(this, object, path, collisions, disp, radsum,
/// sphere_num)` (acclient.c:358709). The decomp lost the x87 compare at
/// 358786; ACE `Sphere.SlideSphere` reads it as `|direction|² < EPSILON →
/// Collided`, used here.
fn sphere_slide_7(this: Sphere, t: &mut CTransition, disp: Vector3, _radsum: f32, n: usize) -> i32 {
    let gs = t.sphere_path.global_sphere[n];
    let c = gcc(t, n);
    let mut normal = c - this.center;
    if normalize_check_small(&mut normal) {
        return 2;
    }
    t.collision_info.set_collision_normal(normal);
    let skid = t
        .collision_info
        .contact_plane
        .or(t.collision_info.last_known_contact_plane)
        .map(|p| p.normal)
        .unwrap_or_else(Vector3::zero);
    // 358745-358747: direction = normal × skid.
    let direction = normal.cross(&skid);
    let glob_offset = gs.center - c + block_offset(t);
    let dir_len_sq = direction.length_squared();
    if dir_len_sq >= EPSILON {
        let along = direction * (glob_offset.dot(&direction) / dir_len_sq);
        if along.length_squared() < EPSILON {
            return 2;
        }
        let off = along - glob_offset;
        t.sphere_path.add_offset_to_check_pos_with_radius(&off, gs.radius);
        return 4;
    }
    if skid.dot(&disp) < 0.0 {
        return 2;
    }
    let off = normal * -glob_offset.dot(&normal);
    t.sphere_path.add_offset_to_check_pos_with_radius(&off, gs.radius);
    4
}

/// `CSphere::land_on_sphere` (acclient.c:359115).
fn sphere_land_on_sphere(this: Sphere, t: &mut CTransition) -> i32 {
    let mut n = gcc(t, 0) - this.center;
    if normalize_check_small(&mut n) {
        return 2;
    }
    t.sphere_path.set_collide(&n);
    t.sphere_path.walkable_allowance = Z_FOR_LANDING;
    3
}

/// `CSphere::collide_with_point` (acclient.c:358808) — the leaf in
/// `sphere_collide_point.rs` with its side effects replayed.
fn sphere_collide_with_point(this: Sphere, t: &mut CTransition, check: Sphere, radsum: f32, n: usize) -> i32 {
    let perfect_clip = t.object_info.state & ois::PERFECT_CLIP != 0;
    match sphere_collide_point::collide_with_point(this.center, gcc(t, n), check.center, radsum, perfect_clip, block_offset(t)) {
        CollideWithPoint::Collided { collision_normal } => {
            if let Some(cn) = collision_normal {
                t.collision_info.set_collision_normal(cn);
            }
            2
        }
        CollideWithPoint::Adjusted { collision_normal, offset } => {
            t.collision_info.set_collision_normal(collision_normal);
            t.sphere_path.add_offset_to_check_pos_with_radius(&offset, check.radius);
            3
        }
    }
}

// ─── CCylSphere::intersects_sphere ───────────────────────────────────────────

/// `CCylSphere::intersects_sphere(this, Position *p, float scale,
/// CTransition *)` (acclient.c:362244): `cache_localspace_sphere(p, 1.0)`,
/// then radius / height / low point scaled and the low point placed by `p`
/// (the cylinder stays world-Z-aligned, exactly as retail's).
pub fn cylsphere_intersects_sphere_at(cyl: &SetupCylSphere, p: &Position, scale: f32, t: &mut CTransition) -> i32 {
    t.sphere_path.cache_localspace_sphere(p, 1.0);
    let scaled_low = cyl.origin * scale;
    let global = WorldCylSphere {
        low_pt: p.frame.localtoglobal(scaled_low),
        radius: cyl.radius * scale,
        height: cyl.height * scale,
    };
    cylsphere_intersects_sphere(&global, t)
}

/// `CCylSphere::intersects_sphere(this, CTransition *)` (acclient.c:362035).
pub fn cylsphere_intersects_sphere(this: &WorldCylSphere, t: &mut CTransition) -> i32 {
    let g0 = t.sphere_path.global_sphere[0];
    let g1 = t.sphere_path.global_sphere[1];
    let multi = t.sphere_path.num_sphere > 1;
    let disp = g0.center - this.low_pt;
    let radsum = this.radius - EPSILON + g0.radius;
    let coll0 = cylsphere_collides_with_sphere(this, g0.center, g0.radius);
    let coll1 = multi && cylsphere_collides_with_sphere(this, g1.center, g1.radius);

    // 362083-362104: PLACEMENT or obstruction-ethereal — overlap only.
    if t.sphere_path.insert_type == InsertType::Placement || t.sphere_path.obstruction_ethereal {
        return if coll0 || coll1 { 2 } else { 1 };
    }
    // 362108-362109.
    if t.sphere_path.step_down {
        return cylsphere_step_sphere_down(this, t, g0, disp, coll0 || coll1);
    }
    // 362110-362128: check_walkable — overlap only.
    if t.sphere_path.check_walkable {
        return if coll0 || coll1 { 2 } else { 1 };
    }
    // 362129-362194.
    if !t.sphere_path.collide {
        let state = t.object_info.state;
        if state & (ois::CONTACT | ois::ON_WALKABLE) != 0 {
            if coll0 {
                return cylsphere_step_sphere_up(this, t, g0, disp, radsum);
            }
            if coll1 {
                let disp1 = g1.center - this.low_pt;
                return cylsphere_slide_sphere(this, t, g1, disp1, 1);
            }
        } else if state & ois::PATH_CLIPPED != 0 {
            if coll0 {
                return cylsphere_collide_with_point(this, t, g0, disp, 0);
            }
        } else {
            if coll0 {
                return cylsphere_land_on_cylinder(this, t, g0, disp);
            }
            if coll1 {
                let disp1 = g1.center - this.low_pt;
                return cylsphere_collide_with_point(this, t, g1, disp1, 1);
            }
        }
        return 1;
    }
    // 362196-362239: collided — interpolate onto the cylinder's top cap.
    if coll0 || coll1 {
        let movement = gcc(t, 0) - g0.center - block_offset(t);
        if movement.z.abs() >= EPSILON {
            let time = (this.height + g0.radius - disp.z) / movement.z;
            let offset = movement * time;
            let ox = offset.x + disp.x;
            let oy = offset.y + disp.y;
            if radsum * radsum < ox * ox + oy * oy {
                return 1;
            }
            let tc = (1.0 - time) * t.sphere_path.walk_interp;
            if tc < t.sphere_path.walk_interp && tc >= -0.1 {
                let mut point = g0.center + offset;
                point.z -= g0.radius;
                t.collision_info
                    .set_contact_plane(plane_through(Vector3::new(0.0, 0.0, 1.0), point), true);
                t.collision_info.contact_plane_cell_id = t.sphere_path.check_pos.objcell_id;
                t.sphere_path.walk_interp = tc;
                t.sphere_path.add_offset_to_check_pos_with_radius(&offset, g0.radius);
                return 3;
            }
        }
        return 2;
    }
    1
}

/// `CCylSphere::step_sphere_down` (acclient.c:361574). `collides` is the
/// already-evaluated `collides_with_sphere(sphere 0) || (sphere 1)` gate.
fn cylsphere_step_sphere_down(this: &WorldCylSphere, t: &mut CTransition, check: Sphere, disp: Vector3, collides: bool) -> i32 {
    if !collides {
        return 1;
    }
    let step = t.sphere_path.step_down_amt * t.sphere_path.walk_interp;
    if step.abs() < EPSILON {
        return 2;
    }
    let dz = this.height + check.radius - disp.z;
    let interp = (1.0 - dz / step) * t.sphere_path.walk_interp;
    if interp >= t.sphere_path.walk_interp || interp < -0.1 {
        return 2;
    }
    let contact = Vector3::new(check.center.x, check.center.y, check.center.z + (dz - check.radius));
    t.collision_info
        .set_contact_plane(plane_through(Vector3::new(0.0, 0.0, 1.0), contact), true);
    t.collision_info.contact_plane_cell_id = t.sphere_path.check_pos.objcell_id;
    t.sphere_path.walk_interp = interp;
    t.sphere_path
        .add_offset_to_check_pos_with_radius(&Vector3::new(0.0, 0.0, dz), check.radius);
    3
}

/// `CCylSphere::normal_of_collision` (acclient.c:361652) for sphere `n`.
fn cyl_normal(this: &WorldCylSphere, t: &CTransition, check: Sphere, disp: Vector3, n: usize) -> (bool, Vector3) {
    cylsphere_normal_of_collision(this, gcc(t, n), disp.z, check.radius)
}

/// `CCylSphere::slide_sphere` (acclient.c:361957).
fn cylsphere_slide_sphere(this: &WorldCylSphere, t: &mut CTransition, check: Sphere, disp: Vector3, n: usize) -> i32 {
    let (_, mut normal) = cyl_normal(this, t, check, disp, n);
    if normalize_check_small(&mut normal) {
        return 2;
    }
    let c = gcc(t, n);
    moving_sphere_slide(t, check, normal, c)
}

/// `CCylSphere::step_sphere_up` (acclient.c:361976). The collision normal is
/// rotated by `localspace_pos` (set by the outer overload's
/// `cache_localspace_sphere(p, 1.0)`) before `step_up` — retail does exactly
/// this (361998-361999).
fn cylsphere_step_sphere_up(this: &WorldCylSphere, t: &mut CTransition, check: Sphere, disp: Vector3, _radsum: f32) -> i32 {
    if t.object_info.step_up_height < check.radius + this.height - disp.z {
        return cylsphere_slide_sphere(this, t, check, disp, 0);
    }
    let (_, mut normal) = cyl_normal(this, t, check, disp, 0);
    if normalize_check_small(&mut normal) {
        return 2;
    }
    let global = t.sphere_path.localspace_pos.frame.localtoglobalvec(normal);
    step_up_or_slide(t, global)
}

/// `CCylSphere::land_on_cylinder` (acclient.c:362015).
fn cylsphere_land_on_cylinder(this: &WorldCylSphere, t: &mut CTransition, check: Sphere, disp: Vector3) -> i32 {
    let (_, mut normal) = cyl_normal(this, t, check, disp, 0);
    if normalize_check_small(&mut normal) {
        return 2;
    }
    t.sphere_path.set_collide(&normal);
    t.sphere_path.walkable_allowance = Z_FOR_LANDING;
    3
}

/// `CCylSphere::collide_with_point` (acclient.c:361705). Without
/// `PERFECT_CLIP` (every mover the faithful driver routes — the local
/// player) retail records the normalised collision normal and returns
/// COLLIDED (361771-361775). The PERFECT_CLIP time-of-impact solve
/// (361776-361955, missiles) is not ported; such a mover gets the same
/// COLLIDED.
fn cylsphere_collide_with_point(this: &WorldCylSphere, t: &mut CTransition, check: Sphere, disp: Vector3, n: usize) -> i32 {
    let (_, mut normal) = cyl_normal(this, t, check, disp, n);
    if normalize_check_small(&mut normal) {
        return 2;
    }
    t.collision_info.set_collision_normal(normal);
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cylsphere's shadow sphere must ENCLOSE it, cap rims included:
    /// radius hypot(r, h/2) about the mid-point. Old code: max(r, h/2) — the
    /// rim of a 0.3 m × 2 m cylinder sat 0.044 m outside.
    #[test]
    fn a_cylsphere_shadow_sphere_encloses_the_cap_rims() {
        let obj = ObjCollider {
            id: 1,
            state: 0,
            weenie: None,
            cell_id: 0x1234_0001,
            origin: Vector3::new(10.0, 10.0, 5.0),
            orientation: Quaternion::identity(),
            scale: 1.0,
            bsp: None,
            bsp_bound: 0.0,
            cylspheres: vec![SetupCylSphere {
                origin: Vector3::zero(),
                radius: 0.3,
                height: 2.0,
            }],
            spheres: Vec::new(),
        };
        let s = obj.shadow_spheres();
        assert_eq!(s.len(), 1);
        let rim = Vector3::new(10.3, 10.0, 7.0); // top cap rim
        let d = (rim - s[0].center).length();
        assert!(d <= s[0].radius + 1e-5, "cap rim {d} outside shadow radius {}", s[0].radius);
    }

    #[test]
    fn switch_is_thread_local_and_default_off() {
        assert!(!obj_collide_in_transition_enabled());
        set_obj_collide_in_transition(true);
        assert!(obj_collide_in_transition_enabled());
        std::thread::spawn(|| assert!(!obj_collide_in_transition_enabled()))
            .join()
            .unwrap();
        set_obj_collide_in_transition(false);
    }
}
