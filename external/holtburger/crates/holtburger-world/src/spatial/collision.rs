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
    // MIN/MAX/HUGE_QUANTUM below: declared-dormant (BSP-M4 placement port);
    // live quantum law lives in holtburger-core movement/common.rs — see
    // docs/2026-06-11-unification-survey/DECISIONS-A1-O5-constants.md (c4).
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

// ===================================================================
// BSP M4 (2026-06-02, INERT) — placement collision CONTEXT.
//
// Faithful, trimmed port of ACE `Transition` / `SpherePath` /
// `CollisionInfo` carrying exactly the state the future `placement_insert`
// loop (M5) reads/writes. Wired into NOTHING in the live solver or the
// per-tick hot loop: every type here is constructed only by
// `PlacementContext::init` and exercised only by the unit tests below.
// The shipped flat-triangle solver (`physics.rs` `clamp_delta_against_*`)
// is untouched, so the shipped client is provably bit-for-bit unchanged.
// All of M4 sits behind the existing DEFAULT-OFF `USE_PHYSICS_BSP` gate
// (the same gate M2/M2b's BSP primitives use in `holtburger-dat`).
// ===================================================================

use crate::spatial::scene::SpatialScene;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Plane, Vector3};
use holtburger_dat::physics::PlacementState;

/// BSP M4 (INERT). Faithful port of ACE `SpherePath.InsertType`
/// (`Physics/SpherePath.cs:8-13`). Selects the collision query mode in the
/// future placement loop: `Placement` / `InitialPlacement` route through
/// the pure two-sphere static overlap test (`Sphere.IntersectsSphere`,
/// `Sphere.cs:304-315`); `Transition` routes through the swept movement
/// solver (M6+, not modeled here).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum InsertType {
    Transition = 0x0,
    Placement = 0x1,
    InitialPlacement = 0x2,
}

impl InsertType {
    /// True for the two modes that take the pure-overlap short-circuit at
    /// `Sphere.cs:304` (`InsertType == Placement`). `InitialPlacement` also
    /// resolves through `FindPlacementPosition` (`Transition.cs:429`) and
    /// switches to `Placement` before the slide retry (`Transition.cs:446`),
    /// so both count as placement for the overlap test once the sphere is
    /// seeded.
    pub const fn is_placement(self) -> bool {
        matches!(self, Self::Placement | Self::InitialPlacement)
    }
}

/// BSP M4 (INERT). A collision sphere in body-LOCAL space, as stored in
/// `SpherePath.LocalSphere` (`SpherePath.cs:17`), already scaled by the
/// body scale in `InitSphere` (`SpherePath.cs:113-114`:
/// `Center * scale, Radius * scale`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SphereLs {
    /// Body-local center (post-scale). ACE `Sphere.Center`.
    pub center: Vector3,
    /// Radius (post-scale). ACE `Sphere.Radius`.
    pub radius: f32,
}

/// BSP M4 (INERT). A collision sphere in WORLD space, as cached in
/// `SpherePath.GlobalSphere` / `GlobalCurrCenter` by `CacheGlobalSphere`
/// (`SpherePath.cs:158-179`) / `CacheGlobalCurrCenter`
/// (`SpherePath.cs:145-152`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SphereWs {
    /// World-space center.
    pub center: Vector3,
    /// Radius (copied from the local sphere, `SpherePath.cs:174`).
    pub radius: f32,
}

/// BSP M4 (INERT). The placement-relevant subset of ACE `CollisionInfo`.
/// Placement only touches the sliding-normal + contact-plane fields:
/// `AdjustOffset` reads them (`Transition.cs:34-87`), and
/// `ValidatePlacementTransition` resets the whole thing on a non-OK slide
/// (`Transition.cs:976-977 CollisionInfo.Init()`). The
/// velocity/target/collision-normal machinery is omitted until M6.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PlacementCollisionInfo {
    pub sliding_normal: Vector3,
    pub sliding_normal_valid: bool,
    pub contact_plane: Option<Plane>,
    pub contact_plane_valid: bool,
    pub contact_plane_is_water: bool,
    /// ACE `ContactPlaneCellID` (`Transition.cs:620`). 0 = none.
    pub contact_plane_cell_id: u32,
}

impl PlacementCollisionInfo {
    /// ACE `CollisionInfo.Init()` reset invoked from
    /// `ValidatePlacementTransition` (`Transition.cs:977`).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// BSP M4 (INERT). The tiny slice of `ObjectInfo` the placement path reads.
/// The pure two-sphere overlap test (`Sphere.cs:304-315`) reads NONE of
/// these; they only matter for the optional StepDown tail of
/// `FindPlacementPosition` (`Transition.cs:449-491`) and the viewer/walkable
/// branches that placement mostly skips. Carried so the future faithful
/// `FindPlacementPosition` compiles without dragging in the full
/// `ObjectInfo` graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PlacementObjectFlags {
    /// ACE `ObjectInfo.StepDown` (`Transition.cs:449`).
    pub step_down: bool,
    /// ACE `ObjectInfoState.IsViewer` (`Transition.cs:110`).
    pub is_viewer: bool,
    /// ACE `ObjectInfoState.OnWalkable` (`Transition.cs:208`).
    pub on_walkable: bool,
}

/// BSP M4 (INERT). The SpherePath sub-state the placement loop drives.
/// Field names map 1:1 to ACE `SpherePath` (`SpherePath.cs:16-59`); only
/// the placement-relevant subset is present (the transition / walkable /
/// local-space-cache fields are intentionally omitted). Two-sphere cylinder
/// = `local_sphere[0]` (low) + `[1]` (high), valid for `0..num_sphere`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpherePathState {
    pub num_sphere: u8,                    // ACE NumSphere
    pub local_sphere: [SphereLs; 2],       // ACE LocalSphere
    pub global_sphere: [SphereWs; 2],      // ACE GlobalSphere
    pub global_curr_center: [SphereWs; 2], // ACE GlobalCurrCenter
    pub insert_type: InsertType,           // ACE InsertType
    pub backup_insert_type: InsertType,    // ACE Backup
    pub begin_cell: Option<u32>,           // ACE BeginCell (cell id)
    pub begin_pos: Option<WorldPosition>,  // ACE BeginPos (None => Placement mode)
    pub end_pos: WorldPosition,            // ACE EndPos
    pub cur_cell: Option<u32>,             // ACE CurCell
    pub cur_pos: WorldPosition,            // ACE CurPos
    pub check_cell: Option<u32>,           // ACE CheckCell
    pub check_pos: WorldPosition,          // ACE CheckPos
    pub global_offset: Vector3,            // ACE GlobalOffset
    pub cell_array_valid: bool,            // ACE CellArrayValid
    pub hits_interior_cell: bool,          // ACE HitsInteriorCell
    pub building_check: bool,              // ACE BuildingCheck
    pub obstruction_ethereal: bool,        // ACE ObstructionEthereal
    pub placement_allows_sliding: bool,    // ACE PlacementAllowsSliding
    pub walkable_allowance: f32,           // ACE WalkableAllowance
}

impl Default for SpherePathState {
    fn default() -> Self {
        // ACE SpherePath() ctor + Init(): PlacementAllowsSliding = true
        // (`SpherePath.cs:61-83`); everything else zero/empty.
        Self {
            num_sphere: 0,
            local_sphere: [SphereLs::default(); 2],
            global_sphere: [SphereWs::default(); 2],
            global_curr_center: [SphereWs::default(); 2],
            insert_type: InsertType::Placement,
            backup_insert_type: InsertType::Placement,
            begin_cell: None,
            begin_pos: None,
            end_pos: WorldPosition::default(),
            cur_cell: None,
            cur_pos: WorldPosition::default(),
            check_cell: None,
            check_pos: WorldPosition::default(),
            global_offset: Vector3::zero(),
            cell_array_valid: false,
            hits_interior_cell: false,
            building_check: false,
            obstruction_ethereal: false,
            placement_allows_sliding: true,
            walkable_allowance: 0.0,
        }
    }
}

/// BSP M4 (INERT). The placement collision CONTEXT — our trimmed port of
/// ACE `Transition` (`Transition.cs:21-26`) carrying exactly the state the
/// future `placement_insert` loop (M5) reads/writes. `cell_array` is a
/// placeholder for ACE's `CellArray` (the candidate-cell list built by
/// `ObjCell.find_cell_list`); M4 stores cell ids and leaves the walker to
/// M5. Wired into NOTHING — constructed by `PlacementContext::init` and
/// exercised only by unit tests under `USE_PHYSICS_BSP` (DEFAULT-OFF).
#[derive(Debug, Clone, PartialEq)]
pub struct PlacementContext {
    pub path: SpherePathState,
    pub collision: PlacementCollisionInfo,
    pub object_flags: PlacementObjectFlags,
    /// ACE `Transition.CellArray` placeholder: candidate cell ids.
    pub cell_array: Vec<u32>,
    /// Mirror of the last `TransitionState` a placement attempt produced
    /// (diagnostic; the real result is returned from the entry points).
    pub last_state: TransitionState,
}

/// Callback the placement loop invokes to test the current `check_pos`
/// cylinder against ONE cell's geometry. In M4 this is supplied by tests
/// (and stays unwired in production); in M5 it wraps the dat-side
/// `BspNode::sphere_intersects_solid_poly` + `placement_insert_bsp`
/// (`holtburger-dat physics.rs`) + `intersects_sphere_placement`. Signature
/// mirrors ACE `ObjCell.FindCollisions(this)` (`Transition.cs:669`).
pub type CellCollisionFn<'a> = dyn FnMut(&mut PlacementContext, u32) -> TransitionState + 'a;

/// M5 (2026-06-02): the real, BSP-backed [`CellCollisionFn`] — the bridge that
/// lets `placement_insert` (and the other M4 entry points) run against the live
/// per-cell physics BSP held by [`SpatialScene`]. For each candidate cell it
/// reads the context's cached GLOBAL sphere centers and calls
/// [`SpatialScene::cell_physics_bsp_placement`] (ACE `BSPTree.placement_insert`),
/// mapping the result back onto the context:
///   * `Ok`       → `OK`
///   * `Collided` → `Collided`
///   * `Adjusted` → apply the WORLD-space displacement via
///     [`PlacementContext::add_offset_to_check_pos`], return `Adjusted`
///
/// A cell with no registered physics BSP yields `OK` (it cannot block) — same
/// fallback as `cell_physics_bsp_solid`.
///
/// INERT — returned for callers/tests; the live integrator does not invoke it
/// (the BSP placement path stays behind `USE_PHYSICS_BSP`, DEFAULT-OFF).
pub fn bsp_cell_collision_fn(
    scene: &SpatialScene,
) -> impl FnMut(&mut PlacementContext, u32) -> TransitionState + '_ {
    move |ctx, cell_id| {
        let num = ctx.path.num_sphere;
        if num == 0 {
            return TransitionState::OK;
        }
        let k = (num as usize).min(2);
        let mut centers = [Vector3::zero(); 2];
        for (i, c) in centers.iter_mut().enumerate().take(k) {
            *c = ctx.path.global_sphere[i].center;
        }
        let radius = ctx.path.global_sphere[0].radius;
        match scene.cell_physics_bsp_placement(cell_id, &centers[..k], radius, num, true) {
            None | Some((PlacementState::Ok, _)) => TransitionState::OK,
            Some((PlacementState::Collided, _)) => TransitionState::Collided,
            Some((PlacementState::Adjusted, world_disp)) => {
                ctx.add_offset_to_check_pos(world_disp);
                TransitionState::Adjusted
            }
        }
    }
}

impl PlacementContext {
    /// ACE `Transition.Init()` (`Transition.cs:604-611`) + `MakeTransition`
    /// (`Transition.cs:690-695`): fresh context, all sub-state default.
    pub fn init() -> Self {
        Self {
            path: SpherePathState::default(),
            collision: PlacementCollisionInfo::default(),
            object_flags: PlacementObjectFlags::default(),
            cell_array: Vec::new(),
            last_state: TransitionState::Invalid,
        }
    }

    /// ACE `Transition.InitSphere` → `SpherePath.InitSphere`
    /// (`Transition.cs:650-658`, `SpherePath.cs:106-120`). Loads the body's
    /// 1- or 2-sphere cylinder, pre-scaling center+radius by `scale`. ACE
    /// clamps `NumSphere` to <= 2 (`SpherePath.cs:108-111`).
    pub fn init_sphere(&mut self, num_sphere: u8, spheres: &[SphereLs], scale: f32) {
        let n = num_sphere.min(2);
        self.path.num_sphere = n;
        for i in 0..n as usize {
            self.path.local_sphere[i] = SphereLs {
                center: spheres[i].center * scale,
                radius: spheres[i].radius * scale,
            };
        }
        // ACE also caches LocalLowPoint here; omitted (transition-only).
    }

    /// ACE `Transition.InitPath` → `SpherePath.InitPath`
    /// (`Transition.cs:636-639`, `SpherePath.cs:85-104`). For PLACEMENT,
    /// `begin_pos` is `None` ⇒ `InsertType = Placement` and
    /// `cur_pos = end_pos` (`SpherePath.cs:97-100`). Then caches the
    /// curr-center spheres.
    pub fn init_path(
        &mut self,
        begin_cell: Option<u32>,
        begin_pos: Option<WorldPosition>,
        end_pos: WorldPosition,
    ) {
        self.path.begin_pos = begin_pos;
        self.path.begin_cell = begin_cell;
        self.path.end_pos = end_pos;
        match begin_pos {
            Some(bp) => {
                self.path.insert_type = InsertType::Transition;
                self.path.cur_pos = bp;
            }
            None => {
                self.path.insert_type = InsertType::Placement;
                self.path.cur_pos = end_pos;
            }
        }
        self.path.cur_cell = begin_cell;
        self.cache_global_curr_center();
    }

    /// ACE `SpherePath.CacheGlobalCurrCenter` (`SpherePath.cs:145-152`):
    /// global = CurPos.LocalToGlobal(LocalSphere[i].Center). ACE's
    /// `LocalToGlobal` rotates the body-local center by the pose frame
    /// BEFORE adding the global offset; our `global_coords` only adds the
    /// landblock offset to `coords`, so we rotate the local center by
    /// `cur_pos.rotation` first, then add and promote to global meters.
    pub fn cache_global_curr_center(&mut self) {
        for i in 0..self.path.num_sphere as usize {
            let local_c = self.path.local_sphere[i].center;
            let rotated = self.path.cur_pos.rotation.rotate_vector(local_c);
            let synth = WorldPosition {
                landblock_id: self.path.cur_pos.landblock_id,
                coords: self.path.cur_pos.coords + rotated,
                rotation: self.path.cur_pos.rotation,
            };
            self.path.global_curr_center[i] = SphereWs {
                center: synth.global_coords(),
                radius: self.path.local_sphere[i].radius,
            };
        }
    }

    /// ACE `SpherePath.CacheGlobalSphere(null)` rebuild branch
    /// (`SpherePath.cs:167-178`): GlobalSphere[i] = CheckPos-relative global.
    /// Same rotation caveat as `cache_global_curr_center`.
    pub fn cache_global_sphere_rebuild(&mut self) {
        for i in 0..self.path.num_sphere as usize {
            let local_c = self.path.local_sphere[i].center;
            let rotated = self.path.check_pos.rotation.rotate_vector(local_c);
            let synth = WorldPosition {
                landblock_id: self.path.check_pos.landblock_id,
                coords: self.path.check_pos.coords + rotated,
                rotation: self.path.check_pos.rotation,
            };
            self.path.global_sphere[i] = SphereWs {
                center: synth.global_coords(),
                radius: self.path.local_sphere[i].radius,
            };
        }
    }

    /// ACE `SpherePath.CacheGlobalSphere(offset)` translate branch
    /// (`SpherePath.cs:160-166`): when an offset is supplied, just shift the
    /// cached global centers (no re-derive). Used by `AddOffsetToCheckPos`.
    pub fn cache_global_sphere_offset(&mut self, offset: Vector3) {
        for i in 0..self.path.num_sphere as usize {
            self.path.global_sphere[i].center = self.path.global_sphere[i].center + offset;
        }
    }

    /// ACE `SpherePath.SetCheckPos(position, cell)` (`SpherePath.cs:271-277`):
    /// set CheckPos+CheckCell, invalidate CellArrayValid, rebuild GlobalSphere.
    pub fn set_check_pos(&mut self, position: WorldPosition, cell: Option<u32>) {
        self.path.check_pos = position;
        self.path.check_cell = cell;
        self.path.cell_array_valid = false;
        self.cache_global_sphere_rebuild();
    }

    /// ACE `SpherePath.AddOffsetToCheckPos(offset)` (`SpherePath.cs:122-127`):
    /// invalidate cell array, shift CheckPos origin, shift cached globals.
    pub fn add_offset_to_check_pos(&mut self, offset: Vector3) {
        self.path.cell_array_valid = false;
        self.path.check_pos.coords = self.path.check_pos.coords + offset;
        self.cache_global_sphere_offset(offset);
    }

    /// ACE `Sphere.IntersectsSphere` PLACEMENT arm (`Sphere.cs:288-315`):
    /// when `InsertType == Placement` (or `ObstructionEthereal`), the test is
    /// a pure two-sphere STATIC overlap — no swept solve, no step/slide.
    ///
    /// `target_center` / `target_radius` describe the static obstacle sphere
    /// being tested (in M5 this comes from the BSP leaf poly's bounding
    /// sphere / the other object's GlobalSphere). Returns `Collided` on
    /// overlap of EITHER cylinder sphere, else `OK`.
    ///
    /// Mirrors `Sphere.cs:302`: `radsum = globSphere.Radius + radius -
    /// EPSILON`. Uses the M1 `collides_with_sphere(disp, radsum)` primitive
    /// (`physics.rs:260`) verbatim — same `disp = globSphere.Center - center`
    /// convention as ACE (`Sphere.cs:291`). `find_time_of_collision` is
    /// deliberately NOT referenced: it is the swept/transition path (M6).
    pub fn intersects_sphere_placement(
        &self,
        target_center: Vector3,
        target_radius: f32,
    ) -> TransitionState {
        use super::physics::collides_with_sphere;
        use physics_globals::EPSILON;

        debug_assert!(self.path.insert_type.is_placement() || self.path.obstruction_ethereal);

        let g0 = self.path.global_sphere[0];
        let disp = g0.center - target_center;
        let radsum = g0.radius + target_radius - EPSILON;

        if collides_with_sphere(disp, radsum) {
            return TransitionState::Collided;
        }
        if self.path.num_sphere > 1 {
            let g1 = self.path.global_sphere[1];
            let disp_ = g1.center - target_center;
            if collides_with_sphere(disp_, radsum) {
                return TransitionState::Collided;
            }
        }
        TransitionState::OK
    }

    /// ACE `Transition.InsertIntoCell(cell, num_insertion_attempts)`
    /// (`Transition.cs:660-684`): retry the cell collision up to N times,
    /// clearing the contact plane on each `Slid`, returning on OK/Collided.
    pub fn insert_into_cell(
        &mut self,
        cell: Option<u32>,
        num_attempts: u32,
        collide: &mut CellCollisionFn<'_>,
    ) -> TransitionState {
        let Some(cell_id) = cell else {
            return TransitionState::Collided; // ACE: cell == null
        };
        let mut state = TransitionState::OK;
        for _ in 0..num_attempts {
            state = collide(self, cell_id);
            match state {
                TransitionState::OK | TransitionState::Collided => return state,
                TransitionState::Slid => {
                    self.collision.contact_plane_valid = false;
                    self.collision.contact_plane_is_water = false;
                }
                _ => {}
            }
        }
        state
    }

    /// ACE `Transition.PlacementInsert()` (`Transition.cs:697-708`): the
    /// placement_insert ENTRY POINT. `Collided` if no CheckCell; else
    /// `InsertIntoCell(checkCell, 3)` and, on OK, `CheckOtherCells`.
    pub fn placement_insert(&mut self, collide: &mut CellCollisionFn<'_>) -> TransitionState {
        let Some(check_cell) = self.path.check_cell else {
            self.last_state = TransitionState::Collided;
            return TransitionState::Collided;
        };
        let mut state = self.insert_into_cell(Some(check_cell), 3, collide);
        if state == TransitionState::OK {
            state = self.check_other_cells(check_cell, collide);
        }
        self.last_state = state;
        state
    }

    /// ACE `Transition.CheckOtherCells(currCell)` (`Transition.cs:150-204`),
    /// M4 PLACEHOLDER. ACE rebuilds the candidate cell list
    /// (`ObjCell.find_cell_list`) then re-tests every neighbor cell except
    /// `currCell`. M4 has no live cell graph, so this iterates the
    /// `cell_array` placeholder (filled by M5's cell walker), applies the
    /// same OK/Slid/Collided/Adjusted switch, and sets
    /// `hits_interior_cell=false` + `cell_array_valid=true` like
    /// `BuildCellArray` (`Transition.cs:91-92`). The outdoor-readjust tail
    /// (`Transition.cs:190-203`) is M5; M4 returns OK when no neighbor blocks.
    pub fn check_other_cells(
        &mut self,
        curr_cell: u32,
        collide: &mut CellCollisionFn<'_>,
    ) -> TransitionState {
        self.path.cell_array_valid = true;
        self.path.hits_interior_cell = false;
        // M5: ObjCell.find_cell_list(CellArray, ref newCell, SpherePath) here.
        for idx in 0..self.cell_array.len() {
            let cell = self.cell_array[idx];
            if cell == curr_cell {
                continue;
            }
            let collides = collide(self, cell);
            match collides {
                TransitionState::Slid => {
                    self.collision.contact_plane_valid = false;
                    self.collision.contact_plane_is_water = false;
                    return collides;
                }
                TransitionState::Collided | TransitionState::Adjusted => return collides,
                _ => {}
            }
        }
        TransitionState::OK
    }

    /// ACE `Transition.ValidatePlacement(transitionState, adjust)`
    /// (`Transition.cs:936-955`): on OK, COMMIT CheckPos→CurPos /
    /// CheckCell→CurCell and re-cache curr center; on Adjusted/Slid with
    /// `adjust`, re-run `PlacementInsert` once (single recursion, then
    /// `adjust=false`).
    pub fn validate_placement(
        &mut self,
        transition_state: TransitionState,
        adjust: bool,
        collide: &mut CellCollisionFn<'_>,
    ) -> TransitionState {
        if self.path.check_cell.is_none() {
            return TransitionState::Collided;
        }
        match transition_state {
            TransitionState::OK => {
                self.path.cur_pos = self.path.check_pos;
                self.path.cur_cell = self.path.check_cell;
                self.cache_global_curr_center();
            }
            TransitionState::Adjusted | TransitionState::Slid => {
                if adjust {
                    let re = self.placement_insert(collide);
                    return self.validate_placement(re, false, collide);
                }
            }
            _ => {}
        }
        transition_state
    }

    /// ACE `Transition.ValidatePlacementTransition(state, ref redo)`
    /// (`Transition.cs:957-982`): on OK commit like ValidatePlacement; on
    /// Collided/Adjusted/Slid reset CollisionInfo when sliding is allowed.
    /// `redo` is always reset to 0 in ACE so we drop it. (Used by
    /// `FindPlacementPos` slide retry — M5.)
    pub fn validate_placement_transition(
        &mut self,
        transition_state: TransitionState,
    ) -> TransitionState {
        if self.path.check_cell.is_none() {
            return TransitionState::Collided;
        }
        match transition_state {
            TransitionState::OK => {
                self.path.cur_pos = self.path.check_pos;
                self.path.cur_cell = self.path.check_cell;
                self.cache_global_curr_center();
            }
            TransitionState::Collided | TransitionState::Adjusted | TransitionState::Slid => {
                if self.path.placement_allows_sliding {
                    self.collision.reset();
                }
            }
            _ => {}
        }
        transition_state
    }

    /// ACE `Transition.FindPlacementPosition()` (`Transition.cs:426-492`),
    /// M4 SKELETON. Seeds CheckPos=CurPos, sets InitialPlacement, runs the
    /// initial `InsertIntoCell(check,3)` + `CheckOtherCells`, then
    /// `ValidatePlacement`. The slide-around-the-clock retry
    /// (`FindPlacementPos`, `Transition.cs:336-424`) and the StepDown tail
    /// (`Transition.cs:449-491`) are M5 — left as TODOs so the entry point
    /// reads faithfully without the live geometry M4 lacks. Returns `true`
    /// when the initial placement validates OK.
    pub fn find_placement_position(&mut self, collide: &mut CellCollisionFn<'_>) -> bool {
        self.set_check_pos(self.path.cur_pos, self.path.cur_cell);
        self.path.insert_type = InsertType::InitialPlacement;

        let state = if let Some(check_cell) = self.path.check_cell {
            let s = self.insert_into_cell(Some(check_cell), 3, collide);
            if s == TransitionState::OK {
                self.check_other_cells(check_cell, collide)
            } else {
                s
            }
        } else {
            TransitionState::Collided
        };

        let state = self.validate_placement(state, true, collide);
        if state != TransitionState::OK {
            return false;
        }
        self.path.insert_type = InsertType::Placement;
        // M5: FindPlacementPos() slide retry + (ObjectInfo.StepDown ? StepDown).
        true
    }
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

    // ===============================================================
    // BSP M4 (INERT) — placement collision context tests.
    // Exercise the context state machine + the pure overlap test
    // directly; no live geometry needed.
    // ===============================================================

    use holtburger_common::Guid;

    /// Build a `WorldPosition` at landblock 0 (identity rotation) with the
    /// given local coords — keeps `global_coords()` == `coords` so the
    /// global-cache assertions stay arithmetic-simple.
    fn wp(x: f32, y: f32, z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(0),
            coords: Vector3::new(x, y, z),
            rotation: Default::default(),
        }
    }

    // ---- M5: BSP-backed CellCollisionFn bridge into SpatialScene (inert) ----
    use crate::spatial::scene::{CellPhysicsBsp, SpatialScene};
    use holtburger_dat::physics::{BspLeaf, BspNode};

    /// A one-leaf cell at identity orientation. `solid != 0` makes the whole
    /// cell solid (→ Collided); `solid == 0` makes it empty (→ OK).
    /// `poly_ids` must be NON-empty for the leaf's `center_check && solid==1`
    /// solid early-out to fire (`physics.rs:333-337`); the id is absent from
    /// the empty `polys` map, so the query short-circuits on `center_solid`
    /// (`hit_poly` stays None → placement loop widens → Collided) without
    /// needing real boundary geometry. (Boundary-poly displacement / Adjusted
    /// is covered by the dat-side `placement_insert_*` tests.)
    fn leaf_cell(solid: i32) -> CellPhysicsBsp {
        CellPhysicsBsp {
            tree: BspNode::Leaf(BspLeaf {
                index: 0,
                solid,
                sphere: None,
                poly_ids: vec![1],
            }),
            polys: std::collections::HashMap::new(),
            origin: Vector3::zero(),
            orientation: Default::default(),
            scale: 1.0,
        }
    }

    /// A two-sphere PLACEMENT context whose CheckPos+CheckCell are seeded at
    /// landblock 0 (so `global_coords() == coords`).
    fn placement_ctx(cell: u32, radius: f32) -> PlacementContext {
        let mut ctx = PlacementContext::init();
        ctx.init_sphere(
            2,
            &[
                SphereLs {
                    center: Vector3::new(0.0, 0.0, 0.0),
                    radius,
                },
                SphereLs {
                    center: Vector3::new(0.0, 0.0, 1.0),
                    radius,
                },
            ],
            1.0,
        );
        let pos = wp(10.0, 10.0, 0.0);
        ctx.init_path(Some(cell), None, pos);
        ctx.set_check_pos(pos, Some(cell));
        ctx
    }

    #[test]
    fn bsp_bridge_unregistered_cell_is_ok() {
        let scene = SpatialScene::new();
        let cell = 0x1234_0001;
        let mut ctx = placement_ctx(cell, 0.5);
        let mut collide = bsp_cell_collision_fn(&scene);
        assert_eq!(collide(&mut ctx, cell), TransitionState::OK);
    }

    #[test]
    fn bsp_bridge_clean_cell_is_ok() {
        let mut scene = SpatialScene::new();
        let cell = 0x1234_0001;
        scene.insert_cell_physics_bsp(cell, leaf_cell(0));
        let mut ctx = placement_ctx(cell, 0.5);
        let mut collide = bsp_cell_collision_fn(&scene);
        assert_eq!(collide(&mut ctx, cell), TransitionState::OK);
    }

    #[test]
    fn bsp_bridge_solid_cell_collides() {
        let mut scene = SpatialScene::new();
        let cell = 0x1234_0001;
        scene.insert_cell_physics_bsp(cell, leaf_cell(1));
        let mut ctx = placement_ctx(cell, 0.5);
        let mut collide = bsp_cell_collision_fn(&scene);
        assert_eq!(collide(&mut ctx, cell), TransitionState::Collided);
    }

    #[test]
    fn placement_insert_drives_bsp_bridge_end_to_end() {
        // The M4 placement_insert ENTRY POINT, driven by the real M5 BSP
        // bridge, reports Collided against a fully-solid cell and OK against
        // a clean one — proving the M4 loop ↔ M3 dat geometry are wired.
        let cell = 0x1234_0001;

        let mut solid_scene = SpatialScene::new();
        solid_scene.insert_cell_physics_bsp(cell, leaf_cell(1));
        let mut ctx = placement_ctx(cell, 0.5);
        let mut collide = bsp_cell_collision_fn(&solid_scene);
        assert_eq!(ctx.placement_insert(&mut collide), TransitionState::Collided);

        let mut clean_scene = SpatialScene::new();
        clean_scene.insert_cell_physics_bsp(cell, leaf_cell(0));
        let mut ctx2 = placement_ctx(cell, 0.5);
        let mut collide2 = bsp_cell_collision_fn(&clean_scene);
        assert_eq!(ctx2.placement_insert(&mut collide2), TransitionState::OK);
    }

    #[test]
    fn insert_type_placement_predicate() {
        assert!(InsertType::Placement.is_placement());
        assert!(InsertType::InitialPlacement.is_placement());
        assert!(!InsertType::Transition.is_placement());
    }

    #[test]
    fn init_defaults_match_ace() {
        let ctx = PlacementContext::init();
        assert!(ctx.path.placement_allows_sliding);
        assert_eq!(ctx.path.insert_type, InsertType::Placement);
        assert_eq!(ctx.last_state, TransitionState::Invalid);
        assert!(ctx.cell_array.is_empty());
        assert_eq!(ctx.collision, PlacementCollisionInfo::default());
    }

    #[test]
    fn init_path_placement_sets_mode() {
        // begin_pos == None ⇒ Placement, cur_pos = end, cur_cell = begin_cell.
        let end = wp(1.0, 2.0, 3.0);
        let mut ctx = PlacementContext::init();
        ctx.init_path(Some(42), None, end);
        assert_eq!(ctx.path.insert_type, InsertType::Placement);
        assert_eq!(ctx.path.cur_pos, end);
        assert_eq!(ctx.path.cur_cell, Some(42));

        // begin_pos == Some ⇒ Transition, cur_pos = begin.
        let begin = wp(9.0, 9.0, 9.0);
        let mut ctx2 = PlacementContext::init();
        ctx2.init_path(Some(7), Some(begin), end);
        assert_eq!(ctx2.path.insert_type, InsertType::Transition);
        assert_eq!(ctx2.path.cur_pos, begin);
    }

    #[test]
    fn init_sphere_scales_and_clamps() {
        let mut ctx = PlacementContext::init();
        let s0 = SphereLs {
            center: Vector3::new(1.0, 0.0, 1.0),
            radius: 0.5,
        };
        let s1 = SphereLs {
            center: Vector3::new(0.0, 0.0, 2.0),
            radius: 0.5,
        };
        ctx.init_sphere(2, &[s0, s1], 2.0);
        assert_eq!(ctx.path.num_sphere, 2);
        assert_eq!(ctx.path.local_sphere[0].center, Vector3::new(2.0, 0.0, 2.0));
        assert_eq!(ctx.path.local_sphere[0].radius, 1.0);
        assert_eq!(ctx.path.local_sphere[1].center, Vector3::new(0.0, 0.0, 4.0));
        assert_eq!(ctx.path.local_sphere[1].radius, 1.0);

        // num_sphere > 2 clamps to 2.
        let mut ctx2 = PlacementContext::init();
        ctx2.init_sphere(5, &[s0, s1], 1.0);
        assert_eq!(ctx2.path.num_sphere, 2);
    }

    #[test]
    fn intersects_sphere_placement_single_overlap() {
        let mut ctx = PlacementContext::init();
        ctx.path.num_sphere = 1;
        ctx.path.global_sphere[0] = SphereWs {
            center: Vector3::new(0.0, 0.0, 0.0),
            radius: 0.5,
        };
        // Target at distance 0.6 with radius 0.5: disp.len = 0.6,
        // radsum = 0.5+0.5-EPSILON = ~1.0 ⇒ Collided.
        assert_eq!(
            ctx.intersects_sphere_placement(Vector3::new(0.6, 0.0, 0.0), 0.5),
            TransitionState::Collided
        );
        // Target far away (distance 5) ⇒ OK.
        assert_eq!(
            ctx.intersects_sphere_placement(Vector3::new(5.0, 0.0, 0.0), 0.5),
            TransitionState::OK
        );
        // Boundary: target tangent at exactly r0+target_r = 1.0. Because of
        // the `- EPSILON`, a target at distance exactly 1.0 is JUST outside.
        assert_eq!(
            ctx.intersects_sphere_placement(Vector3::new(1.0, 0.0, 0.0), 0.5),
            TransitionState::OK
        );
    }

    #[test]
    fn intersects_sphere_placement_second_sphere() {
        let mut ctx = PlacementContext::init();
        ctx.path.num_sphere = 2;
        // sphere[0] clear of the target, sphere[1] overlapping it.
        ctx.path.global_sphere[0] = SphereWs {
            center: Vector3::new(0.0, 0.0, 0.0),
            radius: 0.5,
        };
        ctx.path.global_sphere[1] = SphereWs {
            center: Vector3::new(0.0, 0.0, 2.0),
            radius: 0.5,
        };
        let target = Vector3::new(0.0, 0.0, 2.1); // close to sphere[1] only
        assert_eq!(
            ctx.intersects_sphere_placement(target, 0.5),
            TransitionState::Collided
        );
        // Forcing num_sphere to 1 ignores the high sphere ⇒ OK.
        ctx.path.num_sphere = 1;
        assert_eq!(
            ctx.intersects_sphere_placement(target, 0.5),
            TransitionState::OK
        );
    }

    #[test]
    fn set_check_pos_invalidates_cell_array_and_rebuilds_globals() {
        let mut ctx = PlacementContext::init();
        ctx.path.num_sphere = 1;
        ctx.path.local_sphere[0] = SphereLs {
            center: Vector3::new(0.0, 0.0, 1.0),
            radius: 0.5,
        };
        ctx.path.cell_array_valid = true;
        let pos = wp(10.0, 20.0, 30.0);
        ctx.set_check_pos(pos, Some(3));
        assert!(!ctx.path.cell_array_valid);
        assert_eq!(ctx.path.check_cell, Some(3));
        // Identity rotation + landblock 0: global = coords + local center.
        assert_eq!(
            ctx.path.global_sphere[0].center,
            Vector3::new(10.0, 20.0, 31.0)
        );
        assert_eq!(ctx.path.global_sphere[0].radius, 0.5);
    }

    #[test]
    fn add_offset_translates_globals() {
        let mut ctx = PlacementContext::init();
        ctx.path.num_sphere = 1;
        ctx.path.local_sphere[0] = SphereLs {
            center: Vector3::zero(),
            radius: 0.5,
        };
        ctx.set_check_pos(wp(1.0, 1.0, 1.0), Some(1));
        let before = ctx.path.global_sphere[0].center;
        let off = Vector3::new(2.0, 0.0, -1.0);
        ctx.add_offset_to_check_pos(off);
        assert_eq!(ctx.path.global_sphere[0].center, before + off);
        assert_eq!(ctx.path.check_pos.coords, Vector3::new(3.0, 1.0, 0.0));
        assert!(!ctx.path.cell_array_valid);
    }

    #[test]
    fn insert_into_cell_null_cell_collides() {
        let mut ctx = PlacementContext::init();
        let mut invoked = 0;
        let mut cb = |_c: &mut PlacementContext, _id: u32| {
            invoked += 1;
            TransitionState::OK
        };
        let s = ctx.insert_into_cell(None, 3, &mut cb);
        assert_eq!(s, TransitionState::Collided);
        assert_eq!(invoked, 0, "null cell must not invoke the callback");
    }

    #[test]
    fn insert_into_cell_retries_on_slid_then_ok() {
        let mut ctx = PlacementContext::init();
        ctx.collision.contact_plane_valid = true;
        ctx.collision.contact_plane_is_water = true;
        let mut calls = 0;
        {
            let mut cb = |_c: &mut PlacementContext, _id: u32| {
                calls += 1;
                if calls == 1 {
                    TransitionState::Slid
                } else {
                    TransitionState::OK
                }
            };
            let s = ctx.insert_into_cell(Some(5), 3, &mut cb);
            assert_eq!(s, TransitionState::OK);
        }
        assert_eq!(calls, 2);
        assert!(!ctx.collision.contact_plane_valid, "Slid clears contact plane");
        assert!(!ctx.collision.contact_plane_is_water);

        // Collided first ⇒ returns immediately, one call.
        let mut ctx2 = PlacementContext::init();
        let mut calls2 = 0;
        {
            let mut cb2 = |_c: &mut PlacementContext, _id: u32| {
                calls2 += 1;
                TransitionState::Collided
            };
            let s2 = ctx2.insert_into_cell(Some(5), 3, &mut cb2);
            assert_eq!(s2, TransitionState::Collided);
        }
        assert_eq!(calls2, 1);
    }

    #[test]
    fn placement_insert_no_check_cell_collides() {
        let mut ctx = PlacementContext::init();
        ctx.path.check_cell = None;
        let mut cb = |_c: &mut PlacementContext, _id: u32| TransitionState::OK;
        let s = ctx.placement_insert(&mut cb);
        assert_eq!(s, TransitionState::Collided);
        assert_eq!(ctx.last_state, TransitionState::Collided);
    }

    #[test]
    fn placement_insert_ok_then_check_other_cells() {
        let mut ctx = PlacementContext::init();
        ctx.path.check_cell = Some(11);
        // empty cell_array, callback always OK.
        let mut cb = |_c: &mut PlacementContext, _id: u32| TransitionState::OK;
        let s = ctx.placement_insert(&mut cb);
        assert_eq!(s, TransitionState::OK);
        assert!(!ctx.path.hits_interior_cell);
        assert!(ctx.path.cell_array_valid);
        assert_eq!(ctx.last_state, TransitionState::OK);
    }

    #[test]
    fn check_other_cells_skips_curr_and_returns_blocker() {
        let mut ctx = PlacementContext::init();
        ctx.cell_array = vec![1, 2];
        // curr = 1 (skipped), 2 ⇒ Collided.
        {
            let mut cb = |_c: &mut PlacementContext, id: u32| {
                if id == 2 {
                    TransitionState::Collided
                } else {
                    TransitionState::OK
                }
            };
            let s = ctx.check_other_cells(1, &mut cb);
            assert_eq!(s, TransitionState::Collided);
        }

        // Slid on `other` ⇒ returns Slid AND clears contact plane.
        let mut ctx2 = PlacementContext::init();
        ctx2.cell_array = vec![1, 2];
        ctx2.collision.contact_plane_valid = true;
        ctx2.collision.contact_plane_is_water = true;
        {
            let mut cb2 = |_c: &mut PlacementContext, id: u32| {
                if id == 2 {
                    TransitionState::Slid
                } else {
                    TransitionState::OK
                }
            };
            let s2 = ctx2.check_other_cells(1, &mut cb2);
            assert_eq!(s2, TransitionState::Slid);
        }
        assert!(!ctx2.collision.contact_plane_valid);
        assert!(!ctx2.collision.contact_plane_is_water);
    }

    #[test]
    fn validate_placement_ok_commits() {
        let mut ctx = PlacementContext::init();
        ctx.path.num_sphere = 1;
        ctx.path.local_sphere[0] = SphereLs {
            center: Vector3::zero(),
            radius: 0.5,
        };
        ctx.path.cur_pos = wp(0.0, 0.0, 0.0);
        ctx.path.cur_cell = Some(1);
        ctx.path.check_pos = wp(5.0, 6.0, 7.0);
        ctx.path.check_cell = Some(2);
        let mut cb = |_c: &mut PlacementContext, _id: u32| TransitionState::OK;
        let s = ctx.validate_placement(TransitionState::OK, true, &mut cb);
        assert_eq!(s, TransitionState::OK);
        assert_eq!(ctx.path.cur_pos, wp(5.0, 6.0, 7.0));
        assert_eq!(ctx.path.cur_cell, Some(2));
        // global_curr_center re-cached off the committed cur_pos.
        assert_eq!(
            ctx.path.global_curr_center[0].center,
            Vector3::new(5.0, 6.0, 7.0)
        );
    }

    #[test]
    fn validate_placement_adjusted_reinserts_once() {
        let mut ctx = PlacementContext::init();
        ctx.path.check_cell = Some(9);
        let mut reinserts = 0;
        let mut cb = |_c: &mut PlacementContext, _id: u32| {
            reinserts += 1;
            TransitionState::OK
        };
        // Adjusted with adjust=true ⇒ re-runs placement_insert once, which
        // returns OK; then validate(OK, false) commits ⇒ final OK.
        let s = ctx.validate_placement(TransitionState::Adjusted, true, &mut cb);
        assert_eq!(s, TransitionState::OK);
        // placement_insert ran exactly once (empty cell_array ⇒ 1 collide call).
        assert_eq!(reinserts, 1);
    }

    #[test]
    fn validate_placement_transition_resets_collision_on_slid() {
        let mut ctx = PlacementContext::init();
        ctx.path.check_cell = Some(1);
        ctx.path.placement_allows_sliding = true;
        ctx.collision.contact_plane_valid = true;
        ctx.collision.contact_plane_cell_id = 77;
        let s = ctx.validate_placement_transition(TransitionState::Slid);
        assert_eq!(s, TransitionState::Slid);
        assert_eq!(ctx.collision, PlacementCollisionInfo::default());

        // sliding disallowed ⇒ collision UNCHANGED.
        let mut ctx2 = PlacementContext::init();
        ctx2.path.check_cell = Some(1);
        ctx2.path.placement_allows_sliding = false;
        ctx2.collision.contact_plane_valid = true;
        ctx2.collision.contact_plane_cell_id = 77;
        let saved = ctx2.collision;
        let s2 = ctx2.validate_placement_transition(TransitionState::Slid);
        assert_eq!(s2, TransitionState::Slid);
        assert_eq!(ctx2.collision, saved);
    }

    #[test]
    fn find_placement_position_ok_path() {
        let mut ctx = PlacementContext::init();
        ctx.path.num_sphere = 1;
        ctx.path.local_sphere[0] = SphereLs {
            center: Vector3::zero(),
            radius: 0.5,
        };
        ctx.path.cur_pos = wp(1.0, 2.0, 3.0);
        ctx.path.cur_cell = Some(4);
        let mut cb = |_c: &mut PlacementContext, _id: u32| TransitionState::OK;
        let ok = ctx.find_placement_position(&mut cb);
        assert!(ok);
        assert_eq!(ctx.path.insert_type, InsertType::Placement);
        assert_eq!(ctx.path.cur_pos, ctx.path.check_pos);

        // check_cell None ⇒ Collided path ⇒ false.
        let mut ctx2 = PlacementContext::init();
        ctx2.path.cur_cell = None;
        let mut cb2 = |_c: &mut PlacementContext, _id: u32| TransitionState::OK;
        assert!(!ctx2.find_placement_position(&mut cb2));
    }
}
