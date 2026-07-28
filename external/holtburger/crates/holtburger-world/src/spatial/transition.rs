//! A6-T1/T2 (2026-06-12, W3+ spec S7) — the retail transition pipeline.
//!
//! Retail runs ONE pipeline for every mover: `CPhysicsObj::transition`
//! (acclient.c:320061) → `find_transitional_position`
//! (acclient.c:313171-313340): the move is subdivided into
//! `ceil(3D-dist / sphere-radius)` substeps (`calc_num_steps`,
//! acclient.c:311764), each substep is offset-adjusted off the carried
//! contact plane (`adjust_offset`, acclient.c:313266), inserted into the
//! cell graph (`transitional_insert(this, 3)`, acclient.c:313307) and
//! validated (`validate_transition`, acclient.c:312194) with step-up /
//! step-down / edge-slide / cliff-slide redo handlers, while the cell
//! membership is recomputed from geometry every step (`build_cell_array`,
//! acclient.c:311675-311680).
//!
//! Ours: this module is the PURE pipeline shell. The per-contact rules are
//! the A7 helpers in [`super::physics`] (`step_up_decision`,
//! `step_down_resolve`, `landing_allows_touchdown`,
//! `slide_residual_along_wall_tangent`, `cliff_slide_residual_along_seam`)
//! — A6 owns the loop, A7 owns the rules. Geometry/state reads go through
//! the [`TransitionEnv`] trait (implemented for `WorldState` below) so the
//! pipeline is consumable by BOTH the legacy manual-drive handle path (T1,
//! `movement/system.rs` swap site) and the canonical tick spine's
//! simulation solve (T2, `client/simulation.rs`) — closing the W1-created
//! P2b hole where `?unifiedTick=on` manual movement had ZERO collision.
//!
//! Flag carriers (both default-off): `USE_UNIFIED_TRANSITION`
//! (movement/system.rs const, native) + `?unifiedTransition=on` (wasm URL
//! flag → `MovementSystemHandle::set_unified_transition`). Flag-off, this
//! module has no caller on the player tick path.
//!
//! Deliberate non-scope (spec S7 §3): A6-T3 remote entities (ROADMAP §8
//! hold), A6-T4 camera (RULINGS §1 parked — the viewer arm of
//! `calc_num_steps` is NOT implemented), A6-T5 projectiles (JS-live),
//! A7-R4 `precipice_slide`, A2 force-position easing internals, and the
//! default-off `USE_PHYSICS_BSP` / `USE_STATIC_BSP` narrow-phase arms
//! (those stay legacy-chain-only until their owners wire them here).

use super::collision::{PlacementCollisionInfo, TransitionState, physics_globals};
use super::entity_collision::{EntityCollider, clamp_delta_against_entities};
use super::physics::{
    FLOOR_Z, LAND_SETTLE_EPS, PLAYER_STEP_DOWN_HEIGHT,
    PLAYER_STEP_UP_HEIGHT, StepDownOutcome, check_walkable,
    clamp_delta_against_buildings_with_normal, clamp_delta_against_cell_walls_dispatch,
    clamp_delta_to_cell_interior,
    cliff_slide_residual_along_seam, floor_normal_under, highest_floor_z_under,
    landing_allows_touchdown, slide_residual_along_wall_tangent, step_down_decision,
    step_down_resolve, step_up_decision, sweep_sphere_against_static_aabbs,
};
use super::scene::SpatialScene;
use super::types::{BuildingAabbEntry, StaticAabbEntry};
use crate::WorldState;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Guid, Plane, Vector3};

/// Retail `ObjectInfoState` bits (names: ACE
/// `ACE.Server.Physics/ObjectInfo.cs:8-23`; semantics verified in the
/// decompile — 0x4 last-step remainder arm acclient.c:313245-313262, 0x8
/// abort acclient.c:313312-313313, 0x10 rotation handling
/// acclient.c:313180-313184 + 313276-313285).
pub mod object_info_state {
    pub const CONTACT: u32 = 0x1;
    pub const ON_WALKABLE: u32 = 0x2;
    pub const IS_VIEWER: u32 = 0x4;
    pub const PATH_CLIPPED: u32 = 0x8;
    pub const FREE_ROTATE: u32 = 0x10;
    pub const EDGE_SLIDE: u32 = 0x200;
    pub const IGNORE_CREATURES: u32 = 0x400;
}

/// The RETAIL player collision spheres, verbatim from Setup `0x02000001`
/// (client_portal.dat: `spheres: [{origin (0,0,0.475), r 0.48},
/// {origin (0,0,1.35), r 0.48}]`, setup height 1.835). Retail — and vanilla
/// ACE (`PartArray`/`SpherePath` read the Setup's sphere list) — collide the
/// player with THESE spheres, not a synthetic capsule.
///
/// Town-Network wedge root cause (2026-07-24, `fix/indoor-nav-no-pose`
/// residual): the faithful transition previously built the player capsule
/// from the hand-tuned `PLAYER_CAPSULE_RADIUS`/`_HEIGHT` (0.4 / 1.8 →
/// spheres r 0.40 at z 0.40/1.40). That capsule is ~8-10 cm SLIMMER than
/// retail's near waist-height geometry, so a slide/settle against e.g. the
/// TN market-stall counter (slab z 0.835..1.275) left the client at poses
/// (contact reach 0.387) that sit ~9 cm INSIDE the retail-sphere contact
/// envelope (reach 0.474). Vanilla ACE then starts every
/// `UpdatePlayerPosition` transition embedded and rejects it (`failed
/// transition from …` forever) — the body wedges. Matching the retail
/// spheres makes the client resolve to poses ACE can transition from.
///
/// Note the low sphere's centre sits 5 mm BELOW its radius: its bottom is at
/// z −0.005, so a grounded settle leaves the feet at floor + 0.005 — exactly
/// the `+0.005` z every retail content position carries.
pub const PLAYER_SETUP_SPHERE_RADIUS: f32 = 0.48;
pub const PLAYER_SETUP_SPHERE_LOW_Z: f32 = 0.475;
pub const PLAYER_SETUP_SPHERE_HIGH_Z: f32 = 1.35;
/// Setup `0x02000001` height (1.835) — the capsule-height figure consistent
/// with the retail sphere stack above.
pub const PLAYER_SETUP_HEIGHT: f32 = 1.835;

/// Retail `OBJECTINFO` — the mover description cached ONCE per transition
/// (`OBJECTINFO::init`, acclient.c:314128-314132: step heights from
/// `CPartArray::GetStepUpHeight/-Down` acclient.c:325400-325424, ethereal
/// bit from the object state).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ObjectInfo {
    pub state: u32,
    /// A7-R1 hydrated per-setup value; fallback
    /// [`PLAYER_STEP_UP_HEIGHT`] (0.6).
    pub step_up_height: f32,
    /// A7-R1 hydrated; fallback [`PLAYER_STEP_DOWN_HEIGHT`] (1.5).
    pub step_down_height: f32,
    /// ↔ acclient.c:314131 / ours `Entity::is_collidable`. Carried for
    /// shape parity; the LOCAL player is never ethereal, and the A7-R6
    /// deferred-solidify re-check stays OUTSIDE this pipeline (spec §1).
    pub ethereal: bool,
    pub radius: f32,
    pub height: f32,
    /// The mover's two-sphere collision capsule as `(centre_z, radius)`
    /// pairs, LOCAL to the feet — the retail Setup sphere list
    /// (`CSetup::sphere`, what `SPHEREPATH::init_sphere` is fed). For the
    /// local player these are the verbatim Setup `0x02000001` spheres
    /// ([`PLAYER_SETUP_SPHERE_LOW_Z`]/[`PLAYER_SETUP_SPHERE_HIGH_Z`] at
    /// [`PLAYER_SETUP_SPHERE_RADIUS`]); vanilla ACE collides the player
    /// with exactly these, so the faithful driver MUST too or the server
    /// rejects the client's settled poses (the TN market-stall wedge).
    pub capsule: [(f32, f32); 2],
    /// The mover's own guid — excluded from the entity-collider sweep.
    pub self_guid: Guid,
}

impl ObjectInfo {
    /// Build the local player's per-transition object description.
    /// `step_up`/`step_down` are the A7-R1 hydrated heights (`None` ⇒
    /// the hardcoded human-body fallbacks — identical for the player,
    /// whose Setup `0x02000001` IS 0.6/1.5). `allow_edge_slide` is the
    /// hydrated `PhysicsState::EDGE_SLIDE` bit.
    pub fn for_local_player(
        step_up: Option<f32>,
        step_down: Option<f32>,
        allow_edge_slide: bool,
        self_guid: Guid,
    ) -> Self {
        let mut state = object_info_state::CONTACT;
        if allow_edge_slide {
            state |= object_info_state::EDGE_SLIDE;
        }
        Self {
            state,
            step_up_height: step_up.unwrap_or(PLAYER_STEP_UP_HEIGHT),
            step_down_height: step_down.unwrap_or(PLAYER_STEP_DOWN_HEIGHT),
            ethereal: false,
            // Retail Setup 0x02000001 dimensions — MUST match the sphere
            // list below (and therefore vanilla ACE's player collision), not
            // the legacy hand-tuned PLAYER_CAPSULE_* pair; see the
            // PLAYER_SETUP_SPHERE_* doc (TN market-stall wedge, 2026-07-24).
            radius: PLAYER_SETUP_SPHERE_RADIUS,
            height: PLAYER_SETUP_HEIGHT,
            capsule: [
                (PLAYER_SETUP_SPHERE_LOW_Z, PLAYER_SETUP_SPHERE_RADIUS),
                (PLAYER_SETUP_SPHERE_HIGH_Z, PLAYER_SETUP_SPHERE_RADIUS),
            ],
            self_guid,
        }
    }
}

/// Extends the M4 `PlacementCollisionInfo` shape with the transition-only
/// fields: `frames_stationary_fall` (set from `transient_state`
/// 0x10/0x20/0x40, acclient.c:320104-320115) and the loop-exit collision
/// normal (consumed at acclient.c:313312).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TransitionCollisionInfo {
    pub base: PlacementCollisionInfo,
    pub frames_stationary_fall: u8,
    pub collision_normal: Option<Vector3>,
}

/// Flag values threaded in from the caller (the consts live in
/// `movement/system.rs`, the flag owner) so the pipeline mirrors the
/// legacy chain's gate behavior without a crate edge back into core.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransitionGates {
    /// `USE_STEP_UP_DOWN` — step-up onto risers / step-down off drops.
    pub step_up_down: bool,
    /// `USE_WALKABLE_STEP_DOWN` (A7-R2) — walkable acceptance on descents.
    pub walkable_step_down: bool,
    /// `USE_LANDING_WALKABLE` (A7-R3) — airborne touchdown allowance.
    pub landing_walkable: bool,
    /// `USE_SETTLE_LAND` (ea2cc7c3, ported to the reachable pipeline 2026-07-23) —
    /// widen the outdoor airborne touchdown ceiling to `terrain_z +
    /// LAND_SETTLE_EPS` (8 cm) for a non-rising mover, so a `vertical_velocity ≈
    /// 0` hover a hair above the plane grounds instead of latching airborne and
    /// sliding forever (the live-diagnosed "~9 yd/s uncommanded drift"). Read only
    /// in `resolve_floor_for_step`'s outdoor descending-touchdown arm; `false` ⇒
    /// ceiling `== terrain_z`, byte-identical to the pre-fix bare gate.
    pub settle_land: bool,
    /// `USE_WATER_COLLISION` — EntirelyWater block + wading-depth raise.
    pub water_collision: bool,
    /// `USE_TERRAIN_WALKABLE_GATE` — F4-2 uphill cliff refusal + contour
    /// slide.
    pub terrain_walkable_gate: bool,
    /// `USE_LOCAL_ENVCELL_ENTRY` — client-local cell entry/exit flips +
    /// the B11 doorway AABB-net relaxation.
    pub local_envcell_entry: bool,
    /// `USE_RAMP_FLOOR_SNAP_FIX` — split indoor floor sources.
    pub ramp_floor_snap_fix: bool,
    /// `SKIP_PARENTED_ENTITY_COLLISION` — FU-1 wielded-child exclusion.
    pub skip_parented_entities: bool,
    /// `USE_WALKABLE_REINSERT_PROBE` (A6/A7-R2, W5) — retail
    /// `CTransition::step_down`'s `check_walkable` acceptance arm
    /// (`acclient.c:312662-312673`): an EDGE_SLIDE mover that did NOT
    /// begin the transition on walkable support must show positive
    /// walkable evidence at a step-down's destination (re-insert probe,
    /// `acclient.c:312475-312524`) or the snap is refused → fall.
    pub walkable_reinsert_probe: bool,
    /// `USE_OUTDOOR_STATIC_GROUNDING` (2026-06-30) — extend the persistent
    /// `ON_WALKABLE` grounded-latch to OUTDOOR poses standing on a resident
    /// static/building surface (e.g. a building ROOF), which the faithful
    /// driver collides via the same static-BSP narrow-phase as indoor floors.
    /// The read site (`faithful_bridge.rs`) additionally gates on the begin
    /// cell carrying a static physics BSP so the pure-terrain heightfield
    /// cliff-stop is unaffected.
    pub outdoor_static_grounding: bool,
    /// `USE_RETAIL_GROUND` (2026-07-02, `?retailGround=off`) — the retail
    /// outdoor ground-movement port in the faithful driver: (a) OBJECTINFO
    /// `step_down` enabled for a non-missile mover (`OBJECTINFO::init`
    /// acclient.c:314131 `step_down = !(state & Missile)`), arming the
    /// per-insert step-down snap + `edge_slide`/`cliff_slide`/
    /// `precipice_slide` chain (acclient.c:312961-313009); (b) the
    /// persistent grounded latch stamped for OUTDOOR terrain too — retail
    /// `get_object_info` carries CONTACT|ON_WALKABLE from `transient_state`
    /// (acclient.c:319074-319099), which keys `validate_walkable`'s FLOOR_Z
    /// slope gate + the real step-down budget; (c) the entry contact-plane
    /// seed (`init_contact_plane`/`init_last_known_contact_plane`,
    /// acclient.c:315599/315612) so `adjust_offset`'s plane projection and
    /// `cliff_slide`'s `cross(N, lastKnownN)` see the prior frame's ground.
    pub retail_ground: bool,
    /// `USE_WORLD_FRAME_TERRAIN_PLANE` (2026-07-28, `?terrainPlaneFrame=off`) —
    /// store OUTDOOR terrain contact planes in the WORLD frame instead of the
    /// cell's landblock-local frame, so the three downstream consumers of a
    /// stored plane's `d` (`validate_transition` BRANCH-A contact restore,
    /// `adjust_offset`'s penetration push-out, and this bridge's cross-frame
    /// entry seed) compare against the driver's world-space spheres in the same
    /// frame. See `SceneObjCell::find_terrain_collisions` for the full note; the
    /// signed-distance computation inside `validate_walkable` is unchanged.
    /// Faithful-arm only (the approximate pipeline never builds dat planes).
    pub world_frame_terrain_plane: bool,
    /// `USE_AIRBORNE_CHECK_CONTACT` (2026-07-28, `?airborneContact=off`) — use
    /// retail's EXACT `CPhysicsObj::check_contact` test (`velocity · N >
    /// 0.00019999999`, acclient.c:316536) for an AIRBORNE mover's entry contact
    /// seed instead of the vertical-arc proxy. The proxy (`!descending`) exists
    /// because grounded retail locomotion is animation-driven (near-zero physics
    /// velocity) — but an airborne mover carries a REAL physics velocity
    /// (`current_planar_velocity` + `vertical_velocity`), so the retail test is
    /// directly available and strictly more faithful there. Fixes COL-17: a jump
    /// arc pressed into a cliff face is `!descending` on the way up, so the proxy
    /// dropped CONTACT, `adjust_offset` had no plane to project along, and the
    /// frozen launch velocity drove into the face where `validate_walkable`'s
    /// `!ON_WALKABLE` push-out lifted the sphere out of it.
    pub airborne_check_contact: bool,
    /// `USE_WALKABLE_LANDING_GROUND` (2026-07-28, `?walkableGround=off`) — the
    /// settle-land hover-snap may only set GROUNDED on a WALKABLE plane
    /// (`N.z >= FloorZ`), not merely a landable one (`N.z >= z_for_landing`,
    /// cos 85°). Retail keeps the two thresholds distinct on purpose: the landing
    /// allowance decides whether you may STOP FALLING on a face, while ON_WALKABLE
    /// — the flag `SetPositionInternal` recomputes from the contact plane
    /// (acclient.c:322598-322604) and the flag `jump_is_allowed` requires
    /// (acclient.c:343941) — needs `floor_z`. Conflating them let a 55° cliff face
    /// read as ground, which re-armed the jump and produced COL-17's ratchet.
    pub walkable_landing_ground: bool,
}

/// Geometry/state reads the pipeline needs — solves the
/// WorldState-vs-SpatialScene split (`movement/system.rs` reads
/// `world.scene.*` plus the terrain/water samplers that live on
/// `WorldState`). Implemented for [`WorldState`] below; tests may provide
/// synthetic impls.
pub trait TransitionEnv {
    fn scene(&self) -> &SpatialScene;
    fn terrain_height_at(&self, x: f32, y: f32) -> Option<f32>;
    fn terrain_normal_at(&self, x: f32, y: f32) -> Option<Vector3>;
    fn water_depth_at(&self, x: f32, y: f32) -> f32;
    fn is_entirely_water_cell_at(&self, x: f32, y: f32) -> bool;
    /// Collidable entity cylinders within `prefilter_dist` of `pose`
    /// (XY), excluding the mover itself. `skip_parented` mirrors FU-1.
    fn entity_colliders_near(
        &self,
        pose: &WorldPosition,
        prefilter_dist: f32,
        exclude: Guid,
        skip_parented: bool,
    ) -> Vec<EntityCollider>;
}

impl TransitionEnv for WorldState {
    fn scene(&self) -> &SpatialScene {
        &self.scene
    }

    fn terrain_height_at(&self, x: f32, y: f32) -> Option<f32> {
        WorldState::terrain_height_at(self, x, y)
    }

    fn terrain_normal_at(&self, x: f32, y: f32) -> Option<Vector3> {
        WorldState::terrain_normal_at(self, x, y)
    }

    fn water_depth_at(&self, x: f32, y: f32) -> f32 {
        WorldState::water_depth_at(self, x, y)
    }

    fn is_entirely_water_cell_at(&self, x: f32, y: f32) -> bool {
        WorldState::is_entirely_water_cell_at(self, x, y)
    }

    fn entity_colliders_near(
        &self,
        pose: &WorldPosition,
        prefilter_dist: f32,
        exclude: Guid,
        skip_parented: bool,
    ) -> Vec<EntityCollider> {
        let player_global = pose.global_coords();
        let prefilter_sq = prefilter_dist * prefilter_dist;
        self.entities
            .iter()
            .filter(|e| {
                e.guid != exclude
                    && e.is_collidable()
                    && !(skip_parented && e.physics_parent_id.is_some())
            })
            .filter_map(|e| {
                let g = e.position.global_coords();
                let dx = g.x - player_global.x;
                let dy = g.y - player_global.y;
                if dx * dx + dy * dy >= prefilter_sq {
                    return None;
                }
                Some(EntityCollider {
                    center_xy: (g.x, g.y),
                    radius: self.entity_collision_radius(e),
                    has_physics_bsp: e.has_physics_bsp(),
                    bsp: self.entity_physics_bsp(e),
                })
            })
            .collect()
    }
}

/// One transition request. `end` carries the FULL desired displacement —
/// velocity integration (smoothing, jump/fall gravity arc, leave-ground
/// stamping) stays OUTSIDE the pipeline, exactly as retail integrates
/// velocity in `update_object` BEFORE `transition()` consumes only
/// old_pos→new_pos (acclient.c:320061). `begin`/`end` share a landblock
/// frame; the pipeline rebuckets per accepted step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransitionInput {
    pub begin: WorldPosition,
    pub end: WorldPosition,
    pub object: ObjectInfo,
    /// Mover is mid-jump/fall at slice entry.
    pub airborne: bool,
    /// Vertical velocity ≤ 0 as measured AFTER this quantum's gravity add
    /// (`vz += az·dt`, system.rs) — i.e. the mover ends the slice non-rising.
    /// Gates the bare below-plane touchdown (a mover that nets below the plane
    /// this slice lands regardless of entry sign). NOTE: this is true for entry
    /// velocities up to `|g|·dt` (~0.98 m/s at MAX_QUANTUM), so it is NOT a
    /// "rising at entry" test — use [`Self::entry_descending`] for that.
    pub descending: bool,
    /// Vertical velocity ≤ 0 at the TRUE slice entry (before this quantum's
    /// gravity add / stop-check). Gates the settle-land EPS band (the 0..EPS
    /// widening ABOVE the plane) so a mover genuinely rising at entry is never
    /// force-landed mid-ascent — the below-plane touchdown still uses the
    /// post-gravity [`Self::descending`]. For a grounded (non-airborne) entry
    /// this is `true`.
    pub entry_descending: bool,
    /// Server-projection / autonomous drives pin contact (legacy
    /// `LocalDriveControl::force_grounded`).
    pub force_grounded: bool,
    pub gates: TransitionGates,
    /// Cliff-slide `N_last` carried across slices
    /// (`world.player.last_known_wall_normal`).
    pub last_known_wall_normal: Option<Vector3>,
    /// acclient.c:320104-320115. Ported for shape; the resolution-side
    /// consumer is spec S7 OPEN QUESTION 1 and stays inert.
    pub frames_stationary_fall: u8,
    /// `USE_RETAIL_GROUND` — the mover's stored contact plane (+ its cell
    /// id) carried across slices (`world.player.last_contact_plane`), the
    /// retail `CPhysicsObj::contact_plane` the transition entry seeds via
    /// `init_contact_plane` (grounded) / `init_last_known_contact_plane`
    /// (stale), acclient.c:319085-319099. `None` = no prior ground known.
    pub last_contact_plane: Option<(Plane, u32)>,
    /// The mover's PHYSICS velocity at slice entry (`current_planar_velocity`
    /// x/y + `vertical_velocity` z), world frame. Read only by the
    /// `airborne_check_contact` arm, which needs retail's exact
    /// `CPhysicsObj::check_contact` dot (`v · contact_plane.N > 2e-4`,
    /// acclient.c:316536). Grounded locomotion is animation-driven, so this is
    /// ~zero for a walking mover — exactly as in retail, where the same test
    /// therefore effectively only fires on the jump/launch impulse.
    pub physics_velocity: Vector3,
}

/// Pipeline result. `grounded` is the FINAL contact state: the caller
/// diffs it against entry (`land()` / `begin_fall()` + leave-ground
/// stamp) — player-state mutation stays caller-side.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransitionOutcome {
    pub pose: WorldPosition,
    /// The LAST wall normal a step surfaced (the
    /// `InitLastKnownContactPlane` stamp the caller carries forward).
    pub wall_normal: Option<Vector3>,
    pub grounded: bool,
    pub cell_changed: bool,
    pub state: TransitionState,
    /// `USE_RETAIL_GROUND` — the settled contact plane (+ cell id) the
    /// caller stores back onto `world.player.last_contact_plane` (the
    /// retail per-frame `SetPositionInternal` contact-plane copy,
    /// acclient.c:322538-322590). `None` on the approximate pipeline and
    /// when the transition ended with no known plane.
    pub contact_plane: Option<(Plane, u32)>,
    /// Retail stationary-fall counter READ-BACK — the post-transition
    /// `collisions->frames_stationary_fall` retail copies back onto the mover
    /// (`CPhysicsObj::report_collision_end`, acclient.c:321862-321918): the
    /// caller persists 1/2 (retail `transient_state` 0x10/0x20), zeroes the
    /// object velocity once the counter exceeds 1, and resets the store on
    /// 0 / 3 (3 ⇔ `validate_transition`'s resting-floor synthesis fired this
    /// frame, acclient.c:312283-312311 — the mover grounded in place). The
    /// approximate pipeline echoes the input seed (no progression there).
    pub frames_stationary_fall: u8,
}

/// Retail `CTransition::calc_num_steps` non-viewer arm
/// (acclient.c:311764, body 311823-311845): `ceil(3D dist / sphere
/// radius)` equal substeps. Inside the pipeline the FULL-3D distance is
/// simply the retail rule (this supersedes the orphan
/// `USE_CALCNUMSTEPS_3D_DIST` gate, physics.rs). The viewer arm
/// (`state & IS_VIEWER`, floor+1 with last-step remainder) is
/// deliberately NOT implemented — A6-T4 is parked (RULINGS §1).
pub fn calc_num_steps(offset: Vector3, radius: f32) -> (u32, Vector3) {
    let dist = offset.length();
    if !(dist > 0.0) || radius <= 0.0 {
        return (1, offset);
    }
    let steps = (dist / radius).ceil().max(1.0) as u32;
    (steps, offset * (1.0 / steps as f32))
}

/// Retail `CTransition::adjust_offset` call site (acclient.c:313266),
/// minimal faithful form (spec S7 §3 Stage B.2 / OQ5): project the
/// pending step off the carried sliding normal when valid. The fuller
/// ACE `Transition.AdjustOffset` arms (z-slope kill, walkable-allowance
/// interaction, Transition.cs:34-87) are the Stage-D fidelity pass.
fn adjust_offset(step: &mut Vector3, collision: &TransitionCollisionInfo) {
    if collision.base.sliding_normal_valid {
        let n = collision.base.sliding_normal;
        let into = step.dot(&n);
        if into < 0.0 {
            *step = *step - n * into;
        }
    }
}

/// Per-slice geometry candidate caches (spec S7 §5 risk 3: gather ONCE
/// per slice, refresh per step only on a cell change — the same data the
/// legacy chain gathers once per slice today).
struct GeometryCaches {
    buildings: Vec<BuildingAabbEntry>,
    statics: Vec<StaticAabbEntry>,
    entities: Vec<EntityCollider>,
    entity_prefilter: f32,
}

impl GeometryCaches {
    fn gather(env: &dyn TransitionEnv, pose: &WorldPosition, object: &ObjectInfo, gates: &TransitionGates, travel: f32) -> Self {
        let entity_prefilter = travel + object.radius + 2.0;
        Self {
            buildings: env.scene().building_aabbs_near_pose(pose),
            statics: env.scene().statics_aabbs_near_pose(pose),
            entities: if object.state & object_info_state::IGNORE_CREATURES != 0 {
                Vec::new()
            } else {
                env.entity_colliders_near(
                    pose,
                    entity_prefilter,
                    object.self_guid,
                    gates.skip_parented_entities,
                )
            },
            entity_prefilter,
        }
    }

    fn refresh(&mut self, env: &dyn TransitionEnv, pose: &WorldPosition, object: &ObjectInfo, gates: &TransitionGates) {
        self.buildings = env.scene().building_aabbs_near_pose(pose);
        self.statics = env.scene().statics_aabbs_near_pose(pose);
        if object.state & object_info_state::IGNORE_CREATURES == 0 {
            self.entities = env.entity_colliders_near(
                pose,
                self.entity_prefilter,
                object.self_guid,
                gates.skip_parented_entities,
            );
        }
    }
}

/// Cell-transit flips at the step's start pose — retail re-derives cell
/// membership from geometry every step (`build_cell_array`
/// acclient.c:311675-311680 / per-step `find_cell_list`
/// acclient.c:313300-313307; `check_building_transit` acclient.c:348110).
/// Returns `true` when the landblock id changed.
fn step_cell_transit_flips(
    env: &dyn TransitionEnv,
    pose: &mut WorldPosition,
    gates: &TransitionGates,
    radius: f32,
) -> bool {
    if !gates.local_envcell_entry {
        return false;
    }
    if !pose.is_indoors() {
        if let Some(entered) = env.scene().entered_envcell_for_outdoor_pose(pose, radius) {
            pose.landblock_id = Guid(entered);
            return true;
        }
    } else if let Some(outdoor) = env.scene().exited_envcell_to_outdoor(pose, radius) {
        pose.landblock_id = Guid(outdoor);
        return true;
    } else {
        // Indoor→indoor cell transit (2026-07-18): parity with the faithful
        // marshal's re-derive (faithful_bridge.rs, the `local_envcell_entry`
        // else-arm). Neither the outdoor rebucket (outdoor-only) nor the
        // entry/exit flips above touch a walk BETWEEN EnvCells of the same
        // dungeon, so this pipeline — still live as the faithful bridge's
        // indoor pre-bake fallback (no cell physics BSP yet) — kept the
        // pose's low word pinned to the begin cell. Re-derive from geometry
        // like retail's per-step `find_cell_list`; `current_cell` falls back
        // to the unchanged id when no loaded AABB contains the point
        // (identity — same fallback the faithful marshal relies on).
        let derived = env.scene().current_cell(pose);
        if derived != pose.landblock_id.0 {
            pose.landblock_id = Guid(derived);
            return true;
        }
    }
    false
}

/// Tier-1 statics stop-and-slide (port of the inline block in the legacy
/// chain — swept-AABB clamp + one slide iteration). The `USE_STATIC_BSP`
/// cede/push-out arms are deliberately NOT duplicated here (default-off;
/// B4 wiring stays the flag-owner's follow-on, spec §3 Stage B.1).
fn clamp_delta_against_statics(
    candidates: &[StaticAabbEntry],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
) -> Vector3 {
    if delta.length_squared() <= 1e-10 || candidates.is_empty() {
        return delta;
    }
    let Some(hit) = sweep_sphere_against_static_aabbs(candidates, pose, delta, radius) else {
        return delta;
    };
    let backoff = 1e-3;
    let safe_t = (hit.t - backoff / delta.length().max(1e-6)).max(0.0);
    let stopped_delta = delta * safe_t;
    let remaining = delta * (1.0 - safe_t);
    let into_normal = remaining.dot(&hit.normal);
    let slide = remaining - hit.normal * into_normal;
    if slide.length_squared() <= 1e-10 {
        return stopped_delta;
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
    let slide_clamped = match sweep_sphere_against_static_aabbs(candidates, &slide_pose, slide, radius)
    {
        Some(slide_hit) => slide * (slide_hit.t - backoff / slide.length().max(1e-6)).max(0.0),
        None => slide,
    };
    stopped_delta + slide_clamped
}

/// The per-step cell-insert analog (retail: the cell's virtual insert
/// inside `insert_into_cell`, acclient.c:311632): the P1 lateral chain in
/// its current order — indoor per-poly walls (+ AABB containment net with
/// the doorway/exit relaxations) or outdoor buildings, then statics, then
/// entity cylinders. Returns the clamped lateral and the wall normal the
/// earliest wall surfaced (the contact-plane seed for `adjust_offset` /
/// the seam skid).
fn insert_check_offset(
    env: &dyn TransitionEnv,
    caches: &GeometryCaches,
    object: &ObjectInfo,
    gates: &TransitionGates,
    pose: &WorldPosition,
    lateral: Vector3,
) -> (Vector3, Option<Vector3>) {
    let scene = env.scene();
    let mut wall_normal: Option<Vector3> = None;
    let clamped = if pose.is_indoors() {
        let cell_id = scene.current_cell(pose);
        let triangles = scene.cell_triangles(cell_id);
        let cell_aabb_opt = scene.cell_aabb(cell_id);
        let exclusion_aabbs = scene.open_door_exclusion_aabbs_near(pose);
        if triangles.is_empty() && cell_aabb_opt.is_none() {
            // Pre-bake gate: refuse to predict indoor motion until the
            // lazy physics bake lands (the academy-rubberband guard).
            Vector3::zero()
        } else {
            let pre_clamped = if !triangles.is_empty() {
                let (clamped, normal) = clamp_delta_against_cell_walls_dispatch(
                    triangles,
                    pose,
                    lateral,
                    object.radius,
                    object.height,
                    &exclusion_aabbs,
                );
                wall_normal = normal;
                clamped
            } else {
                lateral
            };
            // AABB containment net + PR-RR.1 open-door bypass + B11
            // outdoor-exit-room relaxation, exactly as the legacy chain.
            // 2026-06-15 — extended to INTERIOR room-to-room doorways too (must
            // mirror the legacy path in system.rs; the 1070 eye-test may run
            // either path). `at_interior_doorway`'s loaded-neighbour near-test
            // gates against `visible_cells` PVS edges so it can't over-relax.
            let doorway_relax = gates.local_envcell_entry
                && !triangles.is_empty()
                && (scene.cell_has_outdoor_exit(cell_id)
                    || scene.at_interior_doorway(pose, cell_id, object.radius));
            match cell_aabb_opt {
                Some(aabb) if exclusion_aabbs.is_empty() && !doorway_relax => {
                    clamp_delta_to_cell_interior(pose, pre_clamped, &aabb, object.radius)
                }
                _ => pre_clamped,
            }
        }
    } else if caches.buildings.is_empty() {
        lateral
    } else {
        // Pipeline rule: always the `_with_normal` variant — the clamped
        // delta is identical to `clamp_delta_against_buildings` (which
        // delegates), and the surfaced normal is what makes the seam skid
        // ALWAYS available inside the pipeline (the legacy chain gates
        // outdoor normals behind `USE_OUTDOOR_WALL_NORMALS`).
        let (clamped, normal) =
            clamp_delta_against_buildings_with_normal(&caches.buildings, pose, lateral, object.radius);
        wall_normal = normal;
        clamped
    };
    let clamped = clamp_delta_against_statics(&caches.statics, pose, clamped, object.radius);
    let clamped = if caches.entities.is_empty() {
        clamped
    } else {
        clamp_delta_against_entities(&caches.entities, pose, clamped, object.radius)
    };
    (clamped, wall_normal)
}

/// Refused-step slide — the pipeline's redo handler for a step-up the
/// riser height refused. Inside the pipeline the previous step's plane is
/// ALWAYS carried, so the retail cross-product seam skid
/// (`cliff_slide`, acclient.c:312005-312080) is the rule (this is what
/// the orphan `USE_CLIFF_SLIDE_INTRA_SUBSTEP` gate was scaffolded for);
/// degenerate seams fall back to the single-plane tangent slide
/// (`SpherePath.StepUpSlide` → `Sphere.SlideSphere`).
fn refused_step_slide(
    lateral: Vector3,
    lateral_clamped: Vector3,
    wall_normal: Option<Vector3>,
    n_last: Option<Vector3>,
    allow_edge_slide: bool,
) -> Vector3 {
    if !allow_edge_slide {
        return lateral_clamped;
    }
    let Some(n_new) = wall_normal else {
        return lateral_clamped;
    };
    let residual = Vector3::new(
        lateral.x - lateral_clamped.x,
        lateral.y - lateral_clamped.y,
        0.0,
    );
    if residual.length_squared() <= 1e-12 {
        return lateral_clamped;
    }
    if n_new.z < FLOOR_Z
        && let Some(prev) = n_last
        && let Some(seam) = cliff_slide_residual_along_seam(residual, n_new, prev)
    {
        return Vector3::new(
            lateral_clamped.x + seam.x,
            lateral_clamped.y + seam.y,
            lateral_clamped.z,
        );
    }
    let slid = slide_residual_along_wall_tangent(residual, n_new);
    Vector3::new(
        lateral_clamped.x + slid.x,
        lateral_clamped.y + slid.y,
        lateral_clamped.z,
    )
}

/// F4-2 contour slide (port of the system.rs helper): project a refused
/// uphill lateral onto the slope contour.
fn terrain_contour_slide(lateral: Vector3, terrain_normal: Vector3) -> Option<Vector3> {
    let n_xy_len =
        (terrain_normal.x * terrain_normal.x + terrain_normal.y * terrain_normal.y).sqrt();
    if n_xy_len < 1e-6 {
        return None;
    }
    let contour_wall = Vector3 {
        x: terrain_normal.x / n_xy_len,
        y: terrain_normal.y / n_xy_len,
        z: 0.0,
    };
    let slide = slide_residual_along_wall_tangent(lateral, contour_wall);
    if slide.x * slide.x + slide.y * slide.y < 1e-10 {
        return None;
    }
    Some(slide)
}

/// A6/A7-R2 (W5): the slice-entry support normal feeding the OnWalkable
/// stamp — `terrain_normal_at` outdoors, `floor_normal_under` indoors
/// (the same sources the step-down arms consult). `None` = no normal
/// source (unbaked cell / no terrain cache).
fn entry_support_normal_z(env: &dyn TransitionEnv, pose: &WorldPosition) -> Option<f32> {
    let global = pose.global_coords();
    if pose.is_indoors() {
        let scene = env.scene();
        let cell_id = scene.current_cell(pose);
        let triangles = scene.cell_triangles(cell_id);
        if triangles.is_empty() {
            return None;
        }
        let ceiling = scene
            .cell_aabb(cell_id)
            .map(|a| a.max.z + 1.0)
            .unwrap_or(pose.coords.z + 100.0);
        floor_normal_under(triangles, global.x, global.y, ceiling).map(|n| n.z)
    } else {
        env.terrain_normal_at(global.x, global.y).map(|n| n.z)
    }
}

/// A6/A7-R2 (W5) — retail `CTransition::step_down`'s `check_walkable`
/// acceptance (`acclient.c:312662-312673`): a step-down insert that
/// found a walkable contact plane is STILL refused for an EDGE_SLIDE
/// mover unless `!(state & 0x200) || step_up || check_walkable(z_val)`.
/// Mapped onto the pipeline's Snap/Fall outcome: when the gate is on
/// and the mover carries EDGE_SLIDE, a DESCENT snap additionally
/// requires [`check_walkable`] (OnWalkable entry short-circuit, else
/// positive walkable evidence at the destination — `None` normal
/// REFUSES, see physics.rs). Retail's `step_up` skip is structural
/// here: a successful step-up leaves `drop <= 0`, which this filter
/// already passes through. Non-descents and `Fall` outcomes are
/// untouched; gate off = identity.
fn reinsert_probe_filter(
    outcome: StepDownOutcome,
    gates: &TransitionGates,
    object: &ObjectInfo,
    feet_z: f32,
    floor_z: f32,
    support_normal_z: Option<f32>,
) -> StepDownOutcome {
    if !gates.walkable_reinsert_probe
        || object.state & object_info_state::EDGE_SLIDE == 0
        || feet_z - floor_z <= 0.0
    {
        return outcome;
    }
    match outcome {
        StepDownOutcome::Snap(_) => {
            let on_walkable = object.state & object_info_state::ON_WALKABLE != 0;
            if check_walkable(on_walkable, support_normal_z, FLOOR_Z) {
                outcome
            } else {
                StepDownOutcome::Fall
            }
        }
        StepDownOutcome::Fall => StepDownOutcome::Fall,
    }
}

/// The transitional-position substep loop — retail
/// `find_transitional_position` (acclient.c:313171-313340) over the
/// `TransitionEnv` geometry backends. See the module doc for the
/// per-step shape. Rotation is NOT interpolated per step (spec S7 OQ4:
/// our lateral backends take only pose+delta; the caller integrates
/// omega once per slice as today).
pub fn find_transitional_position(
    env: &dyn TransitionEnv,
    input: &TransitionInput,
) -> TransitionOutcome {
    debug_assert_eq!(
        input.object.state & object_info_state::IS_VIEWER,
        0,
        "viewer arm not implemented (A6-T4 parked)"
    );
    debug_assert_eq!(
        input.begin.landblock_id, input.end.landblock_id,
        "begin/end share a landblock frame; the pipeline rebuckets"
    );

    let offset = Vector3::new(
        input.end.coords.x - input.begin.coords.x,
        input.end.coords.y - input.begin.coords.y,
        input.end.coords.z - input.begin.coords.z,
    );
    let (num_steps, step_offset) = calc_num_steps(offset, input.object.radius);

    let mut pose = input.begin;
    let mut airborne = input.airborne && !input.force_grounded;
    let mut collision = TransitionCollisionInfo {
        frames_stationary_fall: input.frames_stationary_fall,
        ..Default::default()
    };
    let mut n_last = input.last_known_wall_normal;
    let mut wall_normal_out: Option<Vector3> = None;
    let mut cell_changed = false;
    let mut state = TransitionState::OK;
    let gates = &input.gates;
    // A6/A7-R2 (W5): retail stamps OBJECTINFO ONCE per transition
    // (`OBJECTINFO::init`, acclient.c:314128); the OnWalkable bit (state
    // & 2, the `check_walkable` short-circuit acclient.c:312490) maps to
    // "entered this slice grounded on walkable support". A `None` entry
    // normal counts as walkable (flag-off conservatism: absence of data
    // at ENTRY never arms the probe). Queried only when the gate is on —
    // flag-off this block is a no-op and `object` is byte-identical.
    let mut object_local = input.object;
    if gates.walkable_reinsert_probe
        && !airborne
        && entry_support_normal_z(env, &pose).is_none_or(|normal_z| normal_z >= FLOOR_Z)
    {
        object_local.state |= object_info_state::ON_WALKABLE;
    }
    let object = &object_local;
    let mut caches = GeometryCaches::gather(env, &pose, object, gates, offset.length());

    for _ in 0..num_steps {
        // adjust_offset consumes the PREVIOUS step's plane, then the
        // per-step validity is cleared before the insert (retail order:
        // acclient.c:313266 → 313286-313288).
        let mut step = step_offset;
        adjust_offset(&mut step, &collision);
        collision.base.sliding_normal_valid = false;
        collision.base.contact_plane_valid = false;

        if step_cell_transit_flips(env, &mut pose, gates, object.radius) {
            cell_changed = true;
            caches.refresh(env, &pose, object, gates);
        }

        let scene = env.scene();
        let indoor_unbaked = if pose.is_indoors() {
            let cell_id = scene.current_cell(&pose);
            scene.cell_triangles(cell_id).is_empty() && scene.cell_aabb(cell_id).is_none()
        } else {
            false
        };

        let step_entry_xy = (pose.coords.x, pose.coords.y);
        let lateral = Vector3::new(step.x, step.y, 0.0);
        let (lateral_clamped, n_new) =
            insert_check_offset(env, &caches, object, gates, &pose, lateral);

        // validate_transition redo handlers — step-up / refused slide.
        let mut stepped_up = false;
        if gates.step_up_down && !airborne && !indoor_unbaked && lateral.length_squared() > 1e-10 {
            let requested_len = lateral.length();
            let clamped_len = lateral_clamped.length();
            let blocked_gap = requested_len - clamped_len;
            let blocked = blocked_gap > (requested_len * 0.1).max(0.01);
            if blocked {
                let intended = WorldPosition {
                    landblock_id: pose.landblock_id,
                    coords: Vector3::new(
                        pose.coords.x + lateral.x,
                        pose.coords.y + lateral.y,
                        pose.coords.z,
                    ),
                    rotation: pose.rotation,
                };
                let dest_global = intended.global_coords();
                let feet_z = pose.coords.z;
                let dest_floor_z: Option<f32> = if intended.is_indoors() {
                    let cell_id = scene.current_cell(&intended);
                    let triangles = scene.cell_triangles(cell_id);
                    let ceiling = feet_z + object.step_up_height;
                    if !triangles.is_empty() {
                        highest_floor_z_under(triangles, dest_global.x, dest_global.y, ceiling)
                    } else {
                        None
                    }
                } else {
                    env.terrain_height_at(dest_global.x, dest_global.y)
                };
                if let Some(new_feet_z) =
                    step_up_decision(blocked, feet_z, dest_floor_z, object.step_up_height)
                {
                    pose.coords.x = intended.coords.x;
                    pose.coords.y = intended.coords.y;
                    pose.coords.z = new_feet_z;
                    stepped_up = true;
                } else {
                    let slid = refused_step_slide(
                        lateral,
                        lateral_clamped,
                        n_new,
                        n_last,
                        object.state & object_info_state::EDGE_SLIDE != 0,
                    );
                    pose.coords.x += slid.x;
                    pose.coords.y += slid.y;
                }
            } else {
                pose.coords.x += lateral_clamped.x;
                pose.coords.y += lateral_clamped.y;
            }
        } else {
            pose.coords.x += lateral_clamped.x;
            pose.coords.y += lateral_clamped.y;
        }

        // Vertical: the step's share of the caller-integrated Z delta,
        // then the floor resolution (snap / touchdown / step-down).
        if !indoor_unbaked {
            if !stepped_up {
                pose.coords.z += step.z;
            }
            resolve_floor_for_step(
                env,
                object,
                gates,
                input.descending,
                input.entry_descending,
                &mut pose,
                &mut airborne,
                step_entry_xy,
            );
        }

        // Bookkeeping: carry the step's wall plane forward (the
        // InitLastKnownContactPlane equivalent) and seed adjust_offset.
        if let Some(n) = n_new {
            n_last = Some(n);
            wall_normal_out = Some(n);
            collision.base.sliding_normal = n;
            collision.base.sliding_normal_valid = true;
            collision.collision_normal = Some(n);
            state = TransitionState::Slid;
        }

        // Per-step outdoor rebucket — the analog of the per-step cell
        // rebuild (the indoor flips ran at step start).
        if !pose.is_indoors() {
            let rebucketed = pose.rebucket_outdoor_landblock();
            if rebucketed.landblock_id != pose.landblock_id {
                cell_changed = true;
                pose = rebucketed;
                caches.refresh(env, &pose, object, gates);
            }
        }

        // Retail loop-exit: collision-normal-valid && PathClipped
        // (acclient.c:313312-313313). The player never carries
        // PATH_CLIPPED today; ported for shape.
        if collision.collision_normal.is_some()
            && object.state & object_info_state::PATH_CLIPPED != 0
        {
            state = TransitionState::Collided;
            break;
        }
    }

    TransitionOutcome {
        pose,
        wall_normal: wall_normal_out,
        grounded: !airborne,
        cell_changed,
        state,
        // USE_RETAIL_GROUND: the approximate pipeline tracks no retail
        // COLLISIONINFO contact plane — the carry lives on the faithful
        // driver only (`faithful_bridge`). `None` keeps the caller's
        // stored plane untouched.
        contact_plane: None,
        // No `validate_transition` here ⇒ no progression: echo the seed so a
        // caller storing the read-back keeps its value unchanged (the same
        // echo retail's no-validate frames produce).
        frames_stationary_fall: collision.frames_stationary_fall,
    }
}

/// Phase 3 B4 (2026-06-28) — additive dispatcher between the existing
/// pipeline and the decomp-faithful `CTransition` driver. Behind the
/// `USE_FAITHFUL_TRANSITION` flag (movement/system.rs):
///   - `faithful == false` (DEFAULT) → the unchanged existing pipeline
///     ([`find_transitional_position`]); the live path is byte-identical.
///   - `faithful == true` → the faithful driver bridge
///     ([`super::faithful_bridge::faithful_find_transitional_position`]):
///     env-cells faithful, statics faithful (Phase C), and — when
///     `faithful_outdoor == true` (Phase D / WS4, `USE_FAITHFUL_OUTDOOR`) —
///     OUTDOOR poses run the faithful terrain driver too; `faithful_outdoor ==
///     false` (`?faithfulOutdoor=off`) keeps the outdoor branch on the existing
///     heightfield path. `faithful_outdoor` is read ONLY when `faithful` is on
///     (it gates the outdoor branch INSIDE the bridge).
///
/// Phase 3 Phase E1 / WS-D (`USE_FAITHFUL_STEPUP`, `?stepUp=off`): the
/// `faithful_stepup` arg carries the step-up / slope & ledge climb toggle into
/// the faithful driver (stored on `CTransition::faithful_stepup`, read by the
/// WS-B indoor-BSP + WS-C terrain climb seams). Like `faithful_outdoor`, it is
/// consumed ONLY when `faithful` is on (the climb only exists inside the
/// faithful driver); the existing pipeline ignores it.
pub fn find_transitional_position_dispatch(
    env: &dyn TransitionEnv,
    input: &TransitionInput,
    faithful: bool,
    faithful_outdoor: bool,
    faithful_stepup: bool,
) -> TransitionOutcome {
    if faithful {
        super::faithful_bridge::faithful_find_transitional_position(
            env,
            input,
            faithful_outdoor,
            faithful_stepup,
        )
    } else {
        find_transitional_position(env, input)
    }
}

/// Per-step floor resolution — the Z half of `validate_transition`:
/// outdoor terrain snap (with the water / walkable-slope gates, A7-R3
/// landing allowance, A7-R2 walkable step-down) and the indoor per-poly
/// snap-up / F4-1 step-down / fall-through guard / ceiling clamp. Direct
/// port of the legacy chain's floor block, parameterized per step.
fn resolve_floor_for_step(
    env: &dyn TransitionEnv,
    object: &ObjectInfo,
    gates: &TransitionGates,
    descending: bool,
    entry_descending: bool,
    pose: &mut WorldPosition,
    airborne: &mut bool,
    step_entry_xy: (f32, f32),
) {
    let scene = env.scene();
    if !pose.is_indoors() {
        let global = pose.global_coords();
        let Some(z) = env.terrain_height_at(global.x, global.y) else {
            return;
        };
        let z = if gates.water_collision {
            z + env.water_depth_at(global.x, global.y)
        } else {
            z
        };
        if *airborne {
            // Touchdown only on the way down (post-gravity `descending`),
            // through the A7-R3 landing allowance.
            //
            // Settle-land (`gates.settle_land`, USE_SETTLE_LAND): a BELOW-plane
            // touchdown uses the bare `pose.coords.z <= z`; the EPS BAND (0..8 cm
            // ABOVE the plane) additionally grounds a mover HOVERING a hair above
            // it, so a `vz ≈ 0` airborne latch doesn't slide forever on frozen
            // (no-friction) airborne velocity. The band requires `entry_descending`
            // — non-rising at TRUE slice entry — because post-gravity `descending`
            // stays true up to an entry vz of ≈ |g|·dt (~0.98 m/s at MAX_QUANTUM),
            // and force-landing a slow riser mid-ascent would short-circuit real
            // jump/hop arcs. Gate off ⇒ band empty, byte-identical to the
            // pre-ea2cc7c3 bare gate. NOTE (flag interdependence): the
            // near-vertical-perch refusal just below is itself gated on
            // `landing_walkable`, so a mover is only kept off a too-steep face
            // when that flag is also on — production runs `USE_SETTLE_LAND` and
            // `USE_LANDING_WALKABLE` together; keep them enabled as a pair.
            // Reachable duplicate of the legacy-chain fix in `movement/system.rs`;
            // see the FINDING in that crate's settle-land test section.
            let in_settle_band = gates.settle_land
                && entry_descending
                && pose.coords.z <= z + LAND_SETTLE_EPS;
            if descending && (pose.coords.z <= z || in_settle_band) {
                let landing_normal = if gates.landing_walkable {
                    env.terrain_normal_at(global.x, global.y)
                } else {
                    None
                };
                if gates.landing_walkable
                    && !landing_allows_touchdown(
                        landing_normal.map(|n| n.z),
                        physics_globals::LANDING_Z,
                    )
                {
                    if let Some(normal) = landing_normal {
                        let lateral = Vector3 {
                            x: pose.coords.x - step_entry_xy.0,
                            y: pose.coords.y - step_entry_xy.1,
                            z: 0.0,
                        };
                        let slid = slide_residual_along_wall_tangent(lateral, normal);
                        pose.coords.x = step_entry_xy.0 + slid.x;
                        pose.coords.y = step_entry_xy.1 + slid.y;
                    }
                } else {
                    pose.coords.z = z;
                    *airborne = false;
                }
            }
        } else if gates.water_collision && env.is_entirely_water_cell_at(global.x, global.y) {
            // F4-4: refuse the grounded step into a fully-water cell.
            pose.coords.x = step_entry_xy.0;
            pose.coords.y = step_entry_xy.1;
        } else if gates.terrain_walkable_gate
            && z > pose.coords.z
            && env
                .terrain_normal_at(global.x, global.y)
                .map(|n| n.z < FLOOR_Z)
                .unwrap_or(false)
        {
            // F4-2: non-walkable uphill face — contour slide or hard stop.
            let mut slid = false;
            if let Some(slide) = env
                .terrain_normal_at(global.x, global.y)
                .and_then(|n| {
                    terrain_contour_slide(
                        Vector3 {
                            x: pose.coords.x - step_entry_xy.0,
                            y: pose.coords.y - step_entry_xy.1,
                            z: 0.0,
                        },
                        n,
                    )
                })
            {
                let cand_local = (step_entry_xy.0 + slide.x, step_entry_xy.1 + slide.y);
                let cand_global = (
                    global.x + (cand_local.0 - pose.coords.x),
                    global.y + (cand_local.1 - pose.coords.y),
                );
                let water_blocked = gates.water_collision
                    && env.is_entirely_water_cell_at(cand_global.0, cand_global.1);
                if !water_blocked
                    && let Some(cand_z) = env.terrain_height_at(cand_global.0, cand_global.1)
                {
                    let cand_steep_uphill = cand_z > pose.coords.z
                        && env
                            .terrain_normal_at(cand_global.0, cand_global.1)
                            .map(|n| n.z < FLOOR_Z)
                            .unwrap_or(false);
                    if !cand_steep_uphill {
                        pose.coords.x = cand_local.0;
                        pose.coords.y = cand_local.1;
                        if (cand_z - pose.coords.z).abs() <= 0.5 {
                            pose.coords.z = cand_z;
                        }
                        slid = true;
                    }
                }
            }
            if !slid {
                pose.coords.x = step_entry_xy.0;
                pose.coords.y = step_entry_xy.1;
            }
        } else {
            // Grounded descent/rise: step-down resolve (A7-R2) or the
            // legacy ledge heuristic.
            const LEDGE_FALL_THRESHOLD_M: f32 = 0.5;
            if gates.step_up_down {
                // Destination support normal — shared by the A7-R2
                // walkable acceptance and the re-insert probe; queried
                // only when a consumer gate is on (flag-off no-op).
                let support_normal_z = if gates.walkable_step_down || gates.walkable_reinsert_probe
                {
                    env.terrain_normal_at(global.x, global.y).map(|n| n.z)
                } else {
                    None
                };
                let step_down_outcome = if gates.walkable_step_down {
                    step_down_resolve(
                        pose.coords.z,
                        z,
                        support_normal_z,
                        object.step_down_height,
                        FLOOR_Z,
                    )
                } else {
                    step_down_decision(pose.coords.z, z, object.step_down_height)
                };
                let step_down_outcome = reinsert_probe_filter(
                    step_down_outcome,
                    gates,
                    object,
                    pose.coords.z,
                    z,
                    support_normal_z,
                );
                match step_down_outcome {
                    StepDownOutcome::Snap(snap_z) => pose.coords.z = snap_z,
                    StepDownOutcome::Fall => *airborne = true,
                }
            } else if pose.coords.z - z > LEDGE_FALL_THRESHOLD_M {
                *airborne = true;
            } else {
                pose.coords.z = z;
            }
        }
    } else {
        // Indoor floor resolution (per-poly snap-up / F4-1 step-down /
        // fall-through guard / ceiling clamp).
        let cell_id = scene.current_cell(pose);
        let global = pose.global_coords();
        let triangles = scene.cell_triangles(cell_id);
        let cell_aabb = scene.cell_aabb(cell_id);
        let ceiling_for_floor_query = cell_aabb
            .map(|a| a.max.z + 1.0)
            .unwrap_or(pose.coords.z + 100.0);
        let poly_floor_z = if !triangles.is_empty() {
            highest_floor_z_under(triangles, global.x, global.y, ceiling_for_floor_query)
        } else {
            None
        };
        let aabb_floor_z = cell_aabb.map(|a| a.min.z);
        if gates.ramp_floor_snap_fix {
            if let Some(floor) = poly_floor_z {
                let snap_z = floor + 0.005;
                if pose.coords.z < snap_z {
                    let refuse_landing = gates.landing_walkable
                        && *airborne
                        && !landing_allows_touchdown(
                            floor_normal_under(
                                triangles,
                                global.x,
                                global.y,
                                ceiling_for_floor_query,
                            )
                            .map(|n| n.z),
                            physics_globals::LANDING_Z,
                        );
                    if !refuse_landing {
                        pose.coords.z = snap_z;
                        if *airborne {
                            *airborne = false;
                        }
                    }
                } else if gates.step_up_down && !*airborne && pose.coords.z > snap_z {
                    // Destination support normal — shared by the A7-R2
                    // walkable acceptance and the re-insert probe
                    // (flag-off: not queried).
                    let support_normal_z =
                        if gates.walkable_step_down || gates.walkable_reinsert_probe {
                            floor_normal_under(
                                triangles,
                                global.x,
                                global.y,
                                ceiling_for_floor_query,
                            )
                            .map(|n| n.z)
                        } else {
                            None
                        };
                    let step_down_outcome = if gates.walkable_step_down {
                        step_down_resolve(
                            pose.coords.z,
                            snap_z,
                            support_normal_z,
                            object.step_down_height,
                            FLOOR_Z,
                        )
                    } else {
                        step_down_decision(pose.coords.z, snap_z, object.step_down_height)
                    };
                    let step_down_outcome = reinsert_probe_filter(
                        step_down_outcome,
                        gates,
                        object,
                        pose.coords.z,
                        snap_z,
                        support_normal_z,
                    );
                    match step_down_outcome {
                        StepDownOutcome::Snap(z) => pose.coords.z = z,
                        StepDownOutcome::Fall => *airborne = true,
                    }
                }
            }
            if let Some(aabb_min) = aabb_floor_z {
                let cell_floor = aabb_min + 0.005;
                if pose.coords.z < cell_floor {
                    pose.coords.z = cell_floor;
                    if *airborne {
                        *airborne = false;
                    }
                }
            }
        } else {
            let floor_z = poly_floor_z.or(aabb_floor_z);
            if let Some(floor) = floor_z {
                let snap_z = floor + 0.005;
                if pose.coords.z < snap_z {
                    pose.coords.z = snap_z;
                    if *airborne {
                        *airborne = false;
                    }
                }
            }
        }
        if let Some(aabb) = cell_aabb {
            let ceiling_z = aabb.max.z - object.height;
            let floor_min = poly_floor_z.or(aabb_floor_z).unwrap_or(aabb.min.z + 0.005);
            if pose.coords.z > ceiling_z {
                pose.coords.z = ceiling_z.max(floor_min);
            }
        }
    }
}

// Keep the Aabb import live for the doorway-exclusion signature even if
// rustc's dead-code analysis changes; the type appears in
// `open_door_exclusion_aabbs_near`'s return used above.
#[allow(dead_code)]
fn _aabb_type_anchor(_: &Aabb) {}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Quaternion;

    fn pose_at(x: f32, y: f32, z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::new(x, y, z),
            rotation: Quaternion::identity(),
        }
    }

    fn gates_default_on() -> TransitionGates {
        TransitionGates {
            step_up_down: true,
            walkable_step_down: false,
            landing_walkable: false,
            settle_land: false,
            water_collision: false,
            terrain_walkable_gate: false,
            local_envcell_entry: true,
            ramp_floor_snap_fix: true,
            skip_parented_entities: true,
            walkable_reinsert_probe: false,
            outdoor_static_grounding: false,
            retail_ground: false,
            world_frame_terrain_plane: true,
            airborne_check_contact: true,
            walkable_landing_ground: true,
        }
    }

    fn local_player_object() -> ObjectInfo {
        ObjectInfo::for_local_player(None, None, true, Guid(0x5000_0001))
    }

    fn input_for(begin: WorldPosition, end: WorldPosition) -> TransitionInput {
        TransitionInput {
            begin,
            end,
            object: local_player_object(),
            airborne: false,
            descending: true,
            entry_descending: true,
            force_grounded: false,
            gates: gates_default_on(),
            last_known_wall_normal: None,
            frames_stationary_fall: 0,
            last_contact_plane: None,
            physics_velocity: Vector3::zero(),
        }
    }

    #[test]
    fn calc_num_steps_sub_radius_is_single_step() {
        // Sub-radius delta ⇒ 1 step ⇒ the behaviour-identical guarantee
        // (physics.rs "pure superset" doc numbers).
        let (steps, per) = calc_num_steps(Vector3::new(0.3, 0.0, 0.0), 0.4);
        assert_eq!(steps, 1);
        assert!((per.x - 0.3).abs() < 1e-6);
    }

    #[test]
    fn calc_num_steps_run_tick_is_two_steps() {
        // 0.43 m run-tick @ r=0.4 ⇒ ceil(1.075) = 2 (physics.rs:37-42).
        let (steps, per) = calc_num_steps(Vector3::new(0.43, 0.0, 0.0), 0.4);
        assert_eq!(steps, 2);
        assert!((per.x - 0.215).abs() < 1e-6);
    }

    #[test]
    fn calc_num_steps_uses_full_3d_distance() {
        // 3D dist = 0.5 (0.3/0.4 planar + 0.0 z is 0.5 via 3-4-5) at
        // r=0.4 ⇒ 2 steps even though the planar part is sub-radius.
        let (steps, _) = calc_num_steps(Vector3::new(0.3, 0.0, 0.4), 0.4);
        assert_eq!(steps, 2);
    }

    #[test]
    fn calc_num_steps_zero_offset_is_one_step() {
        let (steps, per) = calc_num_steps(Vector3::zero(), 0.4);
        assert_eq!(steps, 1);
        assert_eq!(per, Vector3::zero());
    }

    #[test]
    fn object_info_fallback_heights_are_retail_player_values() {
        let object = ObjectInfo::for_local_player(None, None, false, Guid(1));
        assert_eq!(object.step_up_height, 0.6);
        assert_eq!(object.step_down_height, 1.5);
        assert_eq!(object.state & object_info_state::EDGE_SLIDE, 0);
        let slider = ObjectInfo::for_local_player(Some(0.8), Some(2.0), true, Guid(1));
        assert_eq!(slider.step_up_height, 0.8);
        assert_eq!(slider.step_down_height, 2.0);
        assert_ne!(slider.state & object_info_state::EDGE_SLIDE, 0);
    }

    #[test]
    fn adjust_offset_projects_off_carried_sliding_normal() {
        let mut collision = TransitionCollisionInfo::default();
        collision.base.sliding_normal = Vector3::new(-1.0, 0.0, 0.0);
        collision.base.sliding_normal_valid = true;
        let mut step = Vector3::new(0.2, 0.1, 0.0);
        adjust_offset(&mut step, &collision);
        // The +x component drives INTO the -x-facing wall ⇒ removed.
        assert!((step.x - 0.0).abs() < 1e-6);
        assert!((step.y - 0.1).abs() < 1e-6);
        // A step moving AWAY from the plane is untouched.
        let mut away = Vector3::new(-0.2, 0.1, 0.0);
        adjust_offset(&mut away, &collision);
        assert!((away.x + 0.2).abs() < 1e-6);
    }

    #[test]
    fn open_ground_pipeline_reaches_end_pose() {
        // Synthetic world: no geometry, no terrain cache ⇒ the pipeline
        // must walk every substep and land exactly on `end`.
        let world = WorldState::synthetic();
        let begin = pose_at(50.0, 50.0, 10.0);
        let mut end = begin;
        end.coords.x += 1.3; // > 3 radii ⇒ 4 substeps
        let outcome = find_transitional_position(&world, &input_for(begin, end));
        assert!((outcome.pose.coords.x - end.coords.x).abs() < 1e-5);
        assert!((outcome.pose.coords.y - end.coords.y).abs() < 1e-5);
        assert!(outcome.grounded);
        assert_eq!(outcome.state, TransitionState::OK);
        assert_eq!(outcome.wall_normal, None);
    }

    #[test]
    fn building_aabb_blocks_pipeline_step() {
        use crate::spatial::types::BuildingAabbEntry;
        let mut world = WorldState::synthetic();
        let begin = pose_at(50.0, 50.0, 0.0);
        // Wall directly ahead on +x, taller than step-up.
        let global = begin.global_coords();
        world.scene.insert_building_aabb(
            begin.landblock_id.0,
            BuildingAabbEntry {
                building_id: crate::spatial::types::BuildingId::new(
                    begin.landblock_id.0,
                    1,
                    0,
                ),
                part_index: 0,
                aabb: Aabb {
                    min: Vector3::new(global.x + 1.0, global.y - 5.0, global.z - 1.0),
                    max: Vector3::new(global.x + 2.0, global.y + 5.0, global.z + 10.0),
                },
                active: true,
            },
        );
        let mut end = begin;
        end.coords.x += 3.0; // would tunnel straight through the wall
        let outcome = find_transitional_position(&world, &input_for(begin, end));
        // Stopped at (or just before) the wall face minus the capsule
        // radius: 50 + 1.0 - 0.4 = 50.6.
        assert!(
            outcome.pose.coords.x <= 50.6 + 1e-3,
            "pipeline must not pass through the building: x = {}",
            outcome.pose.coords.x
        );
        assert!(outcome.pose.coords.x > 50.0, "some travel before the wall");
        assert!(outcome.wall_normal.is_some(), "wall normal surfaced");
    }

    #[test]
    fn entity_cylinder_blocks_pipeline_step() {
        use crate::entity::Entity;
        let mut world = WorldState::synthetic();
        let player_guid = Guid(0x5000_0001);
        let begin = pose_at(50.0, 50.0, 0.0);
        world.seed_local_player_entity(player_guid, "Player", begin);
        let mut blocker_pose = begin;
        blocker_pose.coords.x += 1.5;
        world.add_entity(Entity::new(
            Guid(0x5000_0002),
            "Blocker".to_string(),
            blocker_pose,
        ));
        let mut end = begin;
        end.coords.x += 3.0;
        let mut input = input_for(begin, end);
        input.object.self_guid = player_guid;
        let outcome = find_transitional_position(&world, &input);
        // Blocked short of the entity (combined radii ≈ 0.8 by default).
        assert!(
            outcome.pose.coords.x < 51.5,
            "pipeline must stop at the entity cylinder: x = {}",
            outcome.pose.coords.x
        );
    }

    #[test]
    fn ignore_creatures_state_skips_entity_sweep() {
        use crate::entity::Entity;
        let mut world = WorldState::synthetic();
        let player_guid = Guid(0x5000_0001);
        let begin = pose_at(50.0, 50.0, 0.0);
        world.seed_local_player_entity(player_guid, "Player", begin);
        let mut blocker_pose = begin;
        blocker_pose.coords.x += 1.5;
        world.add_entity(Entity::new(
            Guid(0x5000_0002),
            "Blocker".to_string(),
            blocker_pose,
        ));
        let mut end = begin;
        end.coords.x += 3.0;
        let mut input = input_for(begin, end);
        input.object.self_guid = player_guid;
        input.object.state |= object_info_state::IGNORE_CREATURES;
        let outcome = find_transitional_position(&world, &input);
        // Tolerance note (2026-07-24 retail-spheres fix): the 3.0 m walk now
        // subdivides into 7 steps of 3/7 (radius 0.48) instead of 8 exactly-
        // representable steps of 0.375 (radius 0.4), so f32 accumulation on a
        // ~50 m-magnitude coordinate leaves ~1e-5-scale round-off. 1e-3 still
        // proves the pass-through (a collision would stop ~0.9 m short).
        assert!((outcome.pose.coords.x - end.coords.x).abs() < 1e-3);
    }

    // ---- A6/A7-R2 (W5): check_walkable re-insert probe lanes ----

    /// Synthetic outdoor terrain split at a global-X boundary: entry
    /// side has its own floor/normal, far side a 0.3 m drop with a
    /// configurable normal source. Wraps a synthetic WorldState for the
    /// scene; the terrain samplers are overridden.
    struct TerrainStepEnv {
        world: WorldState,
        boundary_global_x: f32,
        entry_floor_z: f32,
        drop_floor_z: f32,
        entry_normal_z: Option<f32>,
        drop_normal_z: Option<f32>,
    }

    impl TransitionEnv for TerrainStepEnv {
        fn scene(&self) -> &SpatialScene {
            &self.world.scene
        }
        fn terrain_height_at(&self, x: f32, _y: f32) -> Option<f32> {
            Some(if x < self.boundary_global_x {
                self.entry_floor_z
            } else {
                self.drop_floor_z
            })
        }
        fn terrain_normal_at(&self, x: f32, _y: f32) -> Option<Vector3> {
            let normal_z = if x < self.boundary_global_x {
                self.entry_normal_z
            } else {
                self.drop_normal_z
            };
            normal_z.map(|z| {
                let xy = (1.0 - z * z).max(0.0).sqrt();
                Vector3::new(xy, 0.0, z)
            })
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

    /// Build the step fixture: grounded at z=10 on the entry side,
    /// walking +x across the boundary onto a 0.3 m drop (within the
    /// 1.5 m step-down ⇒ height-only law snaps).
    fn probe_fixture(
        entry_normal_z: Option<f32>,
        drop_normal_z: Option<f32>,
        probe_on: bool,
    ) -> (TerrainStepEnv, TransitionInput) {
        let begin = pose_at(50.0, 50.0, 10.0);
        let env = TerrainStepEnv {
            world: WorldState::synthetic(),
            boundary_global_x: begin.global_coords().x + 0.5,
            entry_floor_z: 10.0,
            drop_floor_z: 9.7,
            entry_normal_z,
            drop_normal_z,
        };
        let mut end = begin;
        end.coords.x += 1.2; // 3 substeps at r=0.4; crosses on step 2
        let mut input = input_for(begin, end);
        input.gates.walkable_reinsert_probe = probe_on;
        (env, input)
    }

    /// Steep entry support (not OnWalkable) + a destination with NO
    /// normal source: the probe finds no positive walkable evidence ⇒
    /// the step-down snap is refused and the mover FALLS
    /// (acclient.c:312662-312673 + the :312518 re-insert probe). Gate
    /// off, identical input snaps (the height-only law) — the byte-
    /// identity arm.
    #[test]
    fn reinsert_probe_refuses_unevidenced_step_down() {
        let (env, input) = probe_fixture(Some(0.3), None, true);
        let outcome = find_transitional_position(&env, &input);
        assert!(!outcome.grounded, "no walkable evidence ⇒ fall");
        assert!(
            (outcome.pose.coords.z - 10.0).abs() < 1e-5,
            "refused snap keeps the entry height: z = {}",
            outcome.pose.coords.z
        );
        // Flag-off: byte-identical legacy snap.
        let (env_off, input_off) = probe_fixture(Some(0.3), None, false);
        let off = find_transitional_position(&env_off, &input_off);
        assert!(off.grounded);
        assert!((off.pose.coords.z - 9.7).abs() < 1e-5);
    }

    /// OnWalkable entry (walkable support at slice entry) short-circuits
    /// the probe (acclient.c:312490, `state & 2`): the snap stands even
    /// with no destination normal source. A `None` ENTRY normal also
    /// counts as OnWalkable (absence at entry never arms the probe).
    #[test]
    fn reinsert_probe_on_walkable_entry_short_circuits() {
        let (env, input) = probe_fixture(Some(0.95), None, true);
        let outcome = find_transitional_position(&env, &input);
        assert!(outcome.grounded);
        assert!((outcome.pose.coords.z - 9.7).abs() < 1e-5);
        let (env_none, input_none) = probe_fixture(None, None, true);
        let none_entry = find_transitional_position(&env_none, &input_none);
        assert!(none_entry.grounded);
    }

    /// Walkable destination evidence passes the probe: steep entry, but
    /// the drop face is walkable (N.z ≥ FLOOR_Z) ⇒ snap accepted.
    #[test]
    fn reinsert_probe_accepts_walkable_destination() {
        let (env, input) = probe_fixture(Some(0.3), Some(0.9), true);
        let outcome = find_transitional_position(&env, &input);
        assert!(outcome.grounded);
        assert!((outcome.pose.coords.z - 9.7).abs() < 1e-5);
    }

    #[test]
    fn refused_step_slide_single_plane_removes_into_wall_component() {
        let lateral = Vector3::new(0.2, 0.1, 0.0);
        let clamped = Vector3::new(0.05, 0.025, 0.0);
        let n = Vector3::new(-1.0, 0.0, 0.0);
        let slid = refused_step_slide(lateral, clamped, Some(n), None, true);
        // Residual (0.15, 0.075) slides to (0, 0.075) along the wall.
        assert!((slid.x - 0.05).abs() < 1e-6);
        assert!((slid.y - 0.1).abs() < 1e-6);
        // Edge-slide refused ⇒ clamped only.
        let dead = refused_step_slide(lateral, clamped, Some(n), None, false);
        assert_eq!(dead, clamped);
    }
}
