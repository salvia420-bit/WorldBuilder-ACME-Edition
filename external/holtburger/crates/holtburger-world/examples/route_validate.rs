//! route_validate — offline physics pre-validation of atlas/corpus routes
//! (NavAtlas W2.6). Walks a route's legs through the SAME faithful
//! CTransition pipeline the live client uses (`faithful_find_transitional_position`
//! + `faithful_find_placement_position`), in a per-frame 30 fps RUN loop with
//! gravity — headless, no server. A leg that ground-walks to its target
//! without wedging is validated; the first leg that STALLS is reported as
//! failed-at-leg-N. Recorded-from-life routes pass trivially; imported/
//! authored routes (nav_file.js) get caught here before a single live-bot
//! minute is spent — and it is no cheat, it is the client's own physics.
//!
//! Directly models `spatial/env840_seam_tests.rs` (the proven 30 fps RUN slice
//! loop: grounded direct-set planar velocity, airborne gravity integration,
//! stationary-fall carry, `last_contact_plane` threading). Reuses only the
//! crate's PUBLIC API (transition + faithful_bridge are `pub mod`), so it is an
//! example, not a crate edit.
//!
//! It ALSO closes the SPEC §5 ETA calibration risk empirically: on a flat
//! grounded slice it measures displacement/frame and reports m/s, confirming
//! ground speed == run_rate × 4.0 (RUN_ANIM_SPEED), the constant atlas.js pins.
//!
//! ## Batch mode (2026-07-20)
//!
//! ```text
//! cargo run -p holtburger-world --example route_validate                # built-in grocer fixture
//! cargo run -p holtburger-world --example route_validate -- route.json  # single hb-route-v1 file
//! cargo run -p holtburger-world --example route_validate -- routes-dir/ # batch a whole directory
//! ```
//!
//! Route files follow the `hb-route-v1` interchange schema (produced by a JS
//! importer from e.g. VTank nav files):
//!
//! ```json
//! {"schema":"hb-route-v1","name":"...","source":"vtank-nav","fileName":"...",
//!  "navType":"once|circular|linear|follow",
//!  "legs":[{"x":0.0,"y":0.0,"z":0.0,"portal":false,"indoor":false,
//!           "meta":{"navType":"jmp","headingDeg":185.0,"holdShift":true,"delayMs":400}}],
//!  "warnings":["..."]}
//! ```
//!
//! Leg coordinates are WORLD-FRAME AC metres (the router leg frame) —
//! converted here into the `(cell, cell/landblock-local coords)` pairs the
//! faithful driver's `WorldPosition` expects via `leg_from_world` below.
//!
//! Leg semantics (SPEC W2.6 item 2):
//! - `portal:true` legs are a teleport re-anchor: the walker's position is
//!   reset to the leg target and RE-GROUNDED (indoor: a real
//!   `faithful_find_placement_position` arrival search — the same settle
//!   retail runs on login/portal arrival; outdoor: terrain height snap).
//! - `meta.navType in {"jmp","rcl"}` legs are ALSO a teleport re-anchor (no
//!   jump/recall physics exists offline) but are logged and counted
//!   distinctly as SKIPPED-JUMP / SKIPPED-RECALL — never claimed as a walked
//!   leg.
//! - `meta.navType in {"pau","cht","chk","vnd","tlk"}` (or no meta) legs are
//!   walked normally — the coordinate is still a real waypoint.
//!
//! ## Furniture recursion (SPEC W2.6 item 3)
//!
//! [CORRECTION 2026-07-20: the live wasm client DOES have a Stab->Setup->GfxObj
//! furniture physics recursion — `walk_setup_parts_with_geom_and_bsp` +
//! `StaticPartBsp` in apps/holtburger-web/src/lib.rs, feeding
//! CELL_STATIC_BSP_PENDING from the indoor stab walk's 0x02 SetupModel arm,
//! landed 2026-06-28 (46a1e697/ba7ed2a8). That recursion is now PORTED into
//! this offline harness's `populate_cell_furniture` below — the previous stub
//! only counted stabs and inserted nothing, so offline validation missed all
//! indoor furniture collision (tables, shelves, counters …) that the live
//! client already collides against. Ported logic:
//! - `stab_id >> 24 == 0x01` (plain GfxObj): fetch, resolve
//!   `physics_polygons` via `physics_bsp`, insert directly at the stab's
//!   world placement (mirrors lib.rs ~18018-18063).
//! - `stab_id >> 24 == 0x02` (SetupModel): fetch the SetupModel, resolve each
//!   part's static placement frame (retail order — `0x65` Resting → `0` →
//!   first; matches the LIVE DEFAULT per docs/url-flags.md `placementId`
//!   default-ON since 2026-06-27; wire_placement is None — stabs don't carry
//!   a server wire-placement id, that's a dynamic-entity concept), apply
//!   per-part `default_scale` when non-unit, resolve physics polygons, and
//!   compose the part frame with the stab's world placement (mirrors lib.rs
//!   ~18065-18110). SetupModel parts are always plain GfxObj refs in
//!   practice (the live walker skips any part id whose top byte isn't 0x01,
//!   same here) — no deeper recursion exists in the live path either.
//!
//! Frame note (2026-07-20 frame audit, HANDOFF-wedge-closeout-phi4-rig):
//! stab frames are LANDBLOCK-local already, the SAME space as the cell's own
//! frame — NOT further offset by the cell's own placement. `populate_cell_furniture`
//! composes `stab.position.origin + landblock_origin` directly, exactly like
//! `fetchEnvCellsInLandblock`'s stab loop in lib.rs (~17971-17982).
//!
//! Run (DAT-gated — prints SKIP if the base dats are absent):
//!   cargo run -p holtburger-world --example route_validate -- [route.json | routes-dir/]
//! With no arg it validates a built-in INDOOR fixture route through the
//! Holtburg grocer EnvCells (Environment 840) — exact, terrain-free.

use std::collections::{BTreeSet, HashMap};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Guid, Plane, Quaternion, Vector3};

use holtburger_dat::file_type::env_cell::EnvCell;
use holtburger_dat::file_type::environment::Environment;
use holtburger_dat::file_type::{GfxObj, SetupModel};
use holtburger_dat::landblock::{CellLandblock, LandblockInfo};
use holtburger_dat::physics::resolve_cell_physics_polygons;
use holtburger_dat::{DatDatabase, ResourceKey, ResourceSource};

use holtburger_world::spatial::faithful_bridge::{faithful_find_placement_position, faithful_find_transitional_position};
use holtburger_world::spatial::transition::{
    ObjectInfo, TransitionEnv, TransitionGates, TransitionInput,
};
use holtburger_world::spatial::{CellMembership, CellPhysicsBsp, EntityCollider, SpatialScene};

const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";
const CELL_DAT: &str = "/home/wbterminal/ac_base_dats/client_cell_1.dat";
const GROCER_LB: u32 = 0xA9B4; // Holtburg grocer landblock (0xA9B4xxxx cells)
const REPORT_DIR: &str = "/mnt/wbterminal2/met-corpus/validation-reports";

// ── the physics env the faithful walker collides against ────────────────────
struct RouteEnv {
    scene: SpatialScene,
}

impl TransitionEnv for RouteEnv {
    fn scene(&self) -> &SpatialScene {
        &self.scene
    }
    fn terrain_height_at(&self, x: f32, y: f32) -> Option<f32> {
        const LB_M: f32 = 192.0;
        const VERT_M: f32 = 24.0;
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        let lb_x = (x / LB_M).floor() as i32;
        let lb_y = (y / LB_M).floor() as i32;
        if !(0..256).contains(&lb_x) || !(0..256).contains(&lb_y) {
            return None;
        }
        let lb = ((lb_x as u32) << 24) | ((lb_y as u32) << 16);
        // Terrain residency lives in the scene itself now (`populate_terrain_heights`
        // during scene build) rather than a harness-private HashMap — this is the
        // SAME grid `SpatialScene::terrain_landblock_resident`/
        // `bake_outdoor_static_overlap_for_landblock` key off, so a landblock this
        // harness populated is coverage-visible to both the walker AND the outdoor
        // static bake in one place.
        let grid = self.scene.terrain_cell_heights(lb)?;
        let local_x = x - lb_x as f32 * LB_M;
        let local_y = y - lb_y as f32 * LB_M;
        let cell_x = (local_x / VERT_M).clamp(0.0, 8.0);
        let cell_y = (local_y / VERT_M).clamp(0.0, 8.0);
        let cx0 = cell_x.floor() as usize;
        let cy0 = cell_y.floor() as usize;
        let cx1 = (cx0 + 1).min(8);
        let cy1 = (cy0 + 1).min(8);
        let fx = cell_x - cx0 as f32;
        let fy = cell_y - cy0 as f32;
        let z00 = grid[cx0 * 9 + cy0];
        let z10 = grid[cx1 * 9 + cy0];
        let z01 = grid[cx0 * 9 + cy1];
        let z11 = grid[cx1 * 9 + cy1];
        let gx = (lb_x as u32) * 8 + cx0 as u32;
        let gy = (lb_y as u32) * 8 + cy0 as u32;
        let cut = holtburger_dat::terrain_subdiv::cell_swto_ne_cut(gx, gy);
        Some(holtburger_dat::terrain_subdiv::triangle_height_in_cell(
            z00, z10, z01, z11, fx, fy, cut,
        ))
    }
    fn terrain_normal_at(&self, _x: f32, _y: f32) -> Option<Vector3> {
        None // slope gate falls back to walkable when None (indoor fixture)
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

// Gate values mirror system.rs::transition_profile (all USE_* = true, read
// 2026-07-18) — identical to env840_seam_tests::gates().
fn gates() -> TransitionGates {
    TransitionGates {
        step_up_down: true,
        walkable_step_down: true,
        landing_walkable: true,
        settle_land: false,
        water_collision: true,
        terrain_walkable_gate: true,
        local_envcell_entry: true,
        ramp_floor_snap_fix: true,
        skip_parented_entities: true,
        walkable_reinsert_probe: true,
        outdoor_static_grounding: true,
        retail_ground: true,
    }
}

fn input_for(begin: WorldPosition, end: WorldPosition, airborne: bool, descending: bool, last_cp: Option<(Plane, u32)>, fsf: u8) -> TransitionInput {
    TransitionInput {
        begin,
        end,
        object: ObjectInfo::for_local_player(None, None, true, Guid(1)),
        airborne,
        descending,
        entry_descending: descending,
        force_grounded: false,
        gates: gates(),
        last_known_wall_normal: None,
        frames_stationary_fall: fsf,
        last_contact_plane: last_cp,
    }
}

/// How a JSON leg's `meta.navType` (or `portal` flag) should be handled —
/// SPEC W2.6 item 2. `Walk` covers `pau`/`cht`/`chk`/`vnd`/`tlk`/no-meta: the
/// coordinate is still a real waypoint, walked normally.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LegKind {
    Walk,
    Portal,
    JumpSkip,
    RecallSkip,
}

impl LegKind {
    fn from_json(portal: bool, meta_nav_type: Option<&str>) -> Self {
        if portal {
            return LegKind::Portal;
        }
        match meta_nav_type {
            Some("jmp") => LegKind::JumpSkip,
            Some("rcl") => LegKind::RecallSkip,
            _ => LegKind::Walk,
        }
    }
}

// A route leg the validator walks toward. `x,y,z` are LANDBLOCK-LOCAL
// (relative to `cell`'s landblock corner), NOT raw world metres — the same
// frame `WorldPosition`/`global_coords()` use. `leg_from_world` below is the
// world-metres -> (cell, local) converter for JSON-sourced legs.
#[derive(Clone, Copy)]
struct Leg {
    cell: u32, // full objCellId the pose starts anchored to (indoor cell / outdoor lb-cell)
    x: f32,
    y: f32,
    z: f32,
    kind: LegKind,
}

fn pose(cell: u32, x: f32, y: f32, z: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(cell),
        coords: Vector3::new(x, y, z),
        rotation: Quaternion::identity(),
    }
}

/// Converts a JSON route leg's WORLD-FRAME metres into a `Leg` (cell +
/// landblock-local coords). Only the landblock corner (top 16 bits of the
/// cell id) is derived here — `global_coords()` only ever reads those bits
/// (`landblock_coords()`, position.rs), so the exact low-word cell index is
/// irrelevant for a plain walk TARGET (it only feeds the target-world-XY
/// arithmetic). For legs that become an actual walker ANCHOR (the route's
/// first leg, or right after a portal/jump/recall re-anchor) BOTH the
/// indoor/outdoor classification AND the real low-word EnvCell id are
/// SELF-DETERMINED by `anchor_pose`/`point_is_indoor` from the loaded scene
/// geometry — never taken from the JSON `indoor` flag. (2026-07-20 corpus
/// note: the JS nav->hb-route-v1 importer has no EnvCell concept and always
/// emits `indoor:false`, so that field is parsed but intentionally UNUSED for
/// leg-frame/classification purposes — see `point_is_indoor`.) The low word
/// built here is always the plain-outdoor `0` — `anchor_pose` rewrites it
/// (to the real cell, or to an indoor sentinel before re-resolving) at the
/// point where it actually matters.
fn leg_from_world(x: f32, y: f32, z: f32, kind: LegKind) -> Leg {
    const LB_M: f32 = 192.0;
    let lb_x = (x / LB_M).floor().max(0.0);
    let lb_y = (y / LB_M).floor().max(0.0);
    let cell = ((lb_x as u32) << 24) | ((lb_y as u32) << 16);
    Leg {
        cell,
        x: x - lb_x * LB_M,
        y: y - lb_y * LB_M,
        z,
        kind,
    }
}

/// Memory guard (SPEC W2.6 item 4, corpus generalization): a dungeon route
/// touches 1-4 landblocks; an outdoor epic route can touch dozens as it
/// crosses open terrain. Loading every EnvCell + outdoor static/building BSP
/// for a large LB set on an 8GB box risks OOM, so a route whose discovered LB
/// set exceeds this is reported `SKIPPED-SCOPE` rather than attempted —
/// loud and explicit, never a silent partial load.
const MAX_LBS_PER_ROUTE: usize = 40;

/// Boundary margin (SPEC W2.6 item 1, corpus generalization): a leg whose
/// landblock-local x/y sits within this many metres of a `0`/`192` edge may
/// have its walk (or its arrival-search AABB probe) reach into the
/// neighbouring landblock's geometry — one terrain cell (24 m) of margin
/// covers that without discovering the whole map.
const BOUNDARY_MARGIN_M: f32 = 24.0;

/// Compute the set of landblocks (high-word keys, `0xXXYY0000`) a route's
/// legs touch, SPEC W2.6 item 1: `floor(x/192), floor(y/192)` per leg (`leg.cell`
/// already carries this — `leg_from_world` derives it per-leg from the WORLD-frame
/// JSON x/y), plus the neighbour(s) across any edge a leg sits within
/// `BOUNDARY_MARGIN_M` of. A leg near a corner (close to two edges) pulls in the
/// diagonal neighbour too, so a walk/arrival-search that crosses the corner still
/// has geometry loaded on both sides.
/// Insert the landblock containing world point `(wx, wy)` into `set`, if in
/// range. Shared by the per-leg pass and the long-leg segment sampler below.
fn insert_landblock_at(set: &mut BTreeSet<u32>, wx: f32, wy: f32) {
    const LB_M: f32 = 192.0;
    let lb_x = (wx / LB_M).floor();
    let lb_y = (wy / LB_M).floor();
    if (0.0..256.0).contains(&lb_x) && (0.0..256.0).contains(&lb_y) {
        set.insert(((lb_x as u32) << 24) | ((lb_y as u32) << 16));
    }
}

fn discover_landblocks(legs: &[Leg]) -> BTreeSet<u32> {
    const LB_M: f32 = 192.0;
    let mut set = BTreeSet::new();
    // Tracks the previous leg's WORLD (x, y) regardless of that leg's kind —
    // a teleport re-anchor's target IS the walker's position going into the
    // next leg (mirrors `validate_route`'s own `cur` tracking), so this is
    // exactly the start point of whatever segment the NEXT `Walk` leg
    // actually traverses.
    let mut prev_world: Option<(f32, f32)> = None;
    for leg in legs {
        let lb = leg.cell & 0xFFFF_0000;
        let lb_x = ((lb >> 24) & 0xFF) as i32;
        let lb_y = ((lb >> 16) & 0xFF) as i32;
        set.insert(lb);
        let world_x = lb_x as f32 * LB_M + leg.x;
        let world_y = lb_y as f32 * LB_M + leg.y;

        let near_west = leg.x < BOUNDARY_MARGIN_M;
        let near_east = leg.x > LB_M - BOUNDARY_MARGIN_M;
        let near_south = leg.y < BOUNDARY_MARGIN_M;
        let near_north = leg.y > LB_M - BOUNDARY_MARGIN_M;
        let deltas: [(i32, i32, bool); 8] = [
            (-1, 0, near_west),
            (1, 0, near_east),
            (0, -1, near_south),
            (0, 1, near_north),
            (-1, -1, near_west && near_south),
            (-1, 1, near_west && near_north),
            (1, -1, near_east && near_south),
            (1, 1, near_east && near_north),
        ];
        for (dx, dy, cond) in deltas {
            if !cond {
                continue;
            }
            let nx = lb_x + dx;
            let ny = lb_y + dy;
            if (0..256).contains(&nx) && (0..256).contains(&ny) {
                set.insert(((nx as u32) << 24) | ((ny as u32) << 16));
            }
        }

        // Long-leg intermediate-landblock fix (found via the real corpus:
        // `bobo-outside.nav` leg 31, a 299m PLAIN WALK leg — no portal/jump
        // adjacent — failed `NoGround` after covering only 182m/299m). A leg
        // longer than roughly half a landblock can cross ONE OR MORE WHOLE
        // landblocks the endpoint-only margin check above never sees (that
        // check only looks at proximity to ITS OWN landblock's edges, not
        // the landblocks a long straight segment passes THROUGH). Sample the
        // segment from the previous leg's world position to this Walk leg's
        // target at a sub-landblock step and register every landblock
        // touched. Gated on `dist <= IMPLAUSIBLE_LEG_DISTANCE_M`: a longer
        // segment is a `FailureKind::ImplausibleLeg` in `validate_route`
        // (never actually walked), so sampling it would just churn through
        // (and risk exceeding `MAX_LBS_PER_ROUTE` on) landblocks nothing
        // will ever traverse.
        if leg.kind == LegKind::Walk {
            if let Some((px, py)) = prev_world {
                let dx = world_x - px;
                let dy = world_y - py;
                let dist = (dx * dx + dy * dy).sqrt();
                if dist > LB_M * 0.4 && dist <= IMPLAUSIBLE_LEG_DISTANCE_M {
                    let steps = (dist / (LB_M * 0.4)).ceil() as u32;
                    for s in 1..steps {
                        let t = s as f32 / steps as f32;
                        insert_landblock_at(&mut set, px + dx * t, py + dy * t);
                    }
                }
            }
        }
        prev_world = Some((world_x, world_y));
    }
    set
}

const DT: f32 = 1.0 / 30.0; // 30 fps slice
const RUN_SPEED: f32 = 4.0; // resolved_manual_run_speed at run_rate 1 (RUN_ANIM_SPEED)
const AZ: f32 = -9.8; // PhysicsGlobals::gravity
const MAX_V: f32 = 50.0;
const ARRIVE_M: f32 = 1.5; // leg considered reached within this XY distance
const WEDGE_LIMIT: u32 = 20; // consecutive frozen airborne slices = stalled

/// Corpus generalization guard (2026-07-20, discovered while batching the
/// real corpus): a single `Walk` leg requiring more than this straight-line
/// XY distance is treated as corrupt/mis-tagged route DATA, not a real
/// waypoint-to-waypoint step, and is failed IMMEDIATELY without entering the
/// slice loop at all — never walked, never budgeted.
///
/// Evidence: across the full 50-route corpus, every LEGITIMATE walk leg
/// (`portal:false`, no `jmp`/`rcl` meta) is `<= 343.7m`; the very next
/// shortest leg in the corpus is `9,183.6m`, then a long tail up to
/// `49,224.1m` — a ~27x, unambiguous gap with nothing in between. Every leg
/// past that gap traces back to a plain-`portal`-or-untagged waypoint whose
/// world x or y sits exactly at (or wraps past) a `256*192 = 49152` map-edge
/// boundary, or to a landblock hundreds of blocks from its neighbours in the
/// route — both signatures of a corrupted/mis-tagged coordinate in the
/// SOURCE nav file (a lifestone recall or a genuinely distant portal that the
/// `jmp`/`rcl` importer tagging missed), not a walkable gap this harness
/// could ever validate. Without this guard such a leg's computed slice budget
/// (`dist/RUN_SPEED/DT × 3`) can reach the tens of millions, and a first
/// full-corpus run without it hung past 590s on exactly one such leg (a
/// budget that large outruns the per-slice `NoGround` coverage guard's
/// ability to bail quickly under some scene/indoor-classification edge
/// case this pass did not chase down — the guard here is the honest,
/// bounded fix: never attempt a leg this data clearly cannot mean).
const IMPLAUSIBLE_LEG_DISTANCE_M: f32 = 500.0;

// ── door-state modeling (gap 3, HANDOFF-metanav-2026-07-20 "Door-state in
// navigation" / Track D residual "stage_bsp_02 door-blind fine-BSP staging")
// ─────────────────────────────────────────────────────────────────────────
//
// The DAT data has NO open/closed state for anything — PhysicsState.Ethereal
// (the bit a door flips when open) is a live server-broadcast property, never
// baked into GfxObj/SetupModel/Stab records (verified: `resolve_stab_placement_frame`
// pulls exactly ONE static frame per part; there is no alternate "open" frame
// to switch to). Worse, the DAT can't even tell us WHICH placements are doors
// specifically — a door is modeled the same way as any other multi-part
// SetupModel (0x02-class model_id: `resolve_placement_physics_bsps`'s `0x02`
// arm, shared verbatim by EnvCell furniture, outdoor loose statics, and
// outdoor buildings), same as a table or a shelf assembly. This is the SAME
// ambiguity the live wasm client already hit and already has a precedent
// mitigation for: `stage_bsp_02`'s doc (lib.rs ~14837-14842) stages a
// building's fine per-part BSP only under an opt-in flag specifically
// BECAUSE "a multi-part SetupModel may include a swinging DOOR LEAF as a part
// and a static BSP can't open" — i.e. the live client's own answer to "is
// this a door" is "can't tell, so don't collide it by default."
//
// This harness mirrors that exact policy rather than inventing a new one:
// `DoorPolicy::AssumeOpen` skips BSP insertion for every 0x02-class
// (multi-part SetupModel) placement — furniture, statics, AND buildings,
// since a dungeon door is exactly as untaggable as a building door here.
// This is coarser than a per-door toggle (legitimate solid multi-part
// furniture goes uncollidable too) but is the CONSERVATIVE, evidence-based
// choice the task allows when true identification isn't derivable offline —
// and it can only ever REMOVE collision, never add it, so it cannot turn a
// real wedge into a false pass for any leg that wasn't already stalling
// against a 0x02 placement.
//
// Applied as a bounded RETRY, never the default: `run_one_route` first
// validates under `Blind` (today's behavior, byte-for-byte — every currently
// VALIDATED route stays VALIDATED, unchanged). Only a `Wall`/`Timeout`
// failure (a genuine blocking-geometry shape, unlike `NoGround`/`Wedge`/
// `ImplausibleLeg` which aren't about a solid obstruction) gets ONE retry
// under `AssumeOpen`, and the retry's verdict is used only if it is no worse
// than the Blind verdict (validates, or fails at a strictly later leg) —
// flagged explicitly in the report (`door_candidates_skipped`,
// `door_policy` fields + a "doors assumed open" verdict suffix) per the
// task's "conservative pass-through, clearly labeled" guidance, never
// silently folded into a plain VALIDATED.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DoorPolicy {
    /// Today's behavior: every placement's BSP is staged regardless of
    /// model_id shape — every door (indoor or outdoor) is permanently CLOSED.
    Blind,
    /// Skip BSP insertion for 0x02-class (multi-part SetupModel) placements —
    /// every potential door leaf (and any ordinary multi-part furniture
    /// sharing the same untaggable model shape) is treated as passable.
    AssumeOpen,
}

/// Is `model_id` a multi-part SetupModel (the ONLY DAT-derivable signal a
/// placement might be door-bearing — see the `DoorPolicy` doc above)?
/// Mirrors the live client's `(model_id >> 24) as u8 == 0x02` test
/// (lib.rs ~14843) and `resolve_placement_physics_bsps`'s own `0x02` arm.
fn is_door_candidate_model(model_id: u32) -> bool {
    (model_id >> 24) as u8 == 0x02
}

/// Why a leg failed to validate — batch-report failure kind (SPEC W2.6 item 4).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FailureKind {
    /// Airborne + near-zero motion for `WEDGE_LIMIT` consecutive slices — the
    /// task-#12 freeze-chain signature (axis-locked input exactly
    /// perpendicular to a blocking plane).
    Wedge,
    /// Slice budget exhausted with almost no net displacement from the leg
    /// start — walked into an immediate blocking plane, never airborne.
    Wall,
    /// Slice budget exhausted, still making some progress but not enough to
    /// arrive — budget miscalibration or a long detour, not a hard block.
    Timeout,
    /// Anchor/re-anchor (start, or post portal/jump/recall) found no
    /// resident geometry to place against — the offline scene doesn't cover
    /// this location (see `anchor_pose`), never a physics-engine failure.
    NoGround,
    /// The leg's straight-line required distance exceeds
    /// `IMPLAUSIBLE_LEG_DISTANCE_M` — a corrupted/mis-tagged waypoint in the
    /// SOURCE route data (see that constant's doc), never attempted.
    ImplausibleLeg,
}

impl FailureKind {
    fn as_str(self) -> &'static str {
        match self {
            FailureKind::Wedge => "wedge",
            FailureKind::Wall => "wall",
            FailureKind::Timeout => "timeout",
            FailureKind::NoGround => "no-ground",
            FailureKind::ImplausibleLeg => "implausible-leg-distance",
        }
    }
}

/// Walk one leg from `start` toward `target_world` (world-frame XY/Z) via the
/// faithful RUN loop. Returns (arrived, end_pose, per-slice horizontal speeds
/// sampled while grounded, failure kind when not arrived). Mirrors
/// env840_run_seam_wedge_slice_loop's per-slice math.
fn walk_leg(env: &RouteEnv, start: WorldPosition, target_world: Vector3, max_slices: u32) -> (bool, WorldPosition, Vec<f32>, Option<FailureKind>) {
    let tgt_world = target_world;
    let start_g = start.global_coords();
    let mut cur = start;
    let mut is_airborne = false;
    let mut vz = 0.0_f32;
    let mut planar = Vector3::new(0.0, 0.0, 0.0);
    let mut last_cp: Option<(Plane, u32)> = None;
    let mut fsf_store = 0_u8;
    let mut wedge = 0u32;
    let mut speeds = Vec::new();

    for _ in 0..max_slices {
        let g = cur.global_coords();
        let dx = tgt_world.x - g.x;
        let dy = tgt_world.y - g.y;
        let dxy = (dx * dx + dy * dy).sqrt();
        if dxy <= ARRIVE_M {
            return (true, cur, speeds, None);
        }
        let was_airborne = is_airborne;
        // heading toward the target (grounded direct-set; airborne freezes planar)
        if !was_airborne {
            let inv = if dxy > 1e-4 { RUN_SPEED / dxy } else { 0.0 };
            planar = Vector3::new(dx * inv, dy * inv, 0.0);
        }
        let mut raw = Vector3::new(planar.x * DT, planar.y * DT, 0.0);
        let mut descending = true;
        let dz = if was_airborne {
            let (mut vx, mut vy, mut vzz) = (planar.x, planar.y, vz);
            let mut mag2 = vx * vx + vy * vy + vzz * vzz;
            let d;
            if mag2 > 0.0 {
                if mag2 > MAX_V * MAX_V {
                    let len = mag2.sqrt();
                    vx = vx / len * MAX_V;
                    vy = vy / len * MAX_V;
                    vzz = vzz / len * MAX_V;
                    mag2 = MAX_V * MAX_V;
                }
                if mag2 - 0.25 * 0.25 < 0.0002 {
                    vx = 0.0;
                    vy = 0.0;
                    vzz = 0.0;
                }
                d = vzz * DT + 0.5 * AZ * DT * DT;
                raw.x = vx * DT;
                raw.y = vy * DT;
            } else {
                d = 0.0;
                raw.x = 0.0;
                raw.y = 0.0;
            }
            vzz += AZ * DT;
            planar.x = vx;
            planar.y = vy;
            vz = vzz;
            descending = vzz <= 0.0;
            d
        } else {
            raw.z
        };

        let mut end = cur;
        end.coords.x += raw.x;
        end.coords.y += raw.y;
        end.coords.z += dz;

        let out = faithful_find_transitional_position(env, &input_for(cur, end, was_airborne, descending, last_cp, fsf_store), true, true);

        // stationary-fall read-back (kill on the frame the counter advanced)
        if out.frames_stationary_fall > 1 && out.frames_stationary_fall != fsf_store {
            planar = Vector3::zero();
            vz = 0.0;
        }
        fsf_store = match out.frames_stationary_fall {
            1 | 2 => out.frames_stationary_fall,
            _ => 0,
        };
        // grounded diff -> land / begin_fall
        if was_airborne && out.grounded {
            is_airborne = false;
            vz = 0.0;
        } else if !was_airborne && !out.grounded {
            is_airborne = true;
            vz = 0.0;
        }
        last_cp = out.contact_plane;

        // measured horizontal speed this slice (grounded only, for ETA calib)
        let moved = ((out.pose.coords.x - cur.coords.x).powi(2) + (out.pose.coords.y - cur.coords.y).powi(2)).sqrt();
        if !is_airborne {
            speeds.push(moved / DT);
        }
        // wedge detector
        if is_airborne && moved < 0.01 {
            wedge += 1;
        } else {
            wedge = 0;
        }
        cur = out.pose;
        if wedge >= WEDGE_LIMIT {
            return (false, cur, speeds, Some(FailureKind::Wedge));
        }
        // Scene-coverage guard: without this, a walk that exits every loaded
        // landblock/EnvCell runs through an uncollidable VOID (no terrain, no
        // BSP) — nothing blocks it, so it can cruise indefinitely and
        // eventually "arrive" at a target thousands of metres away, a false
        // VALIDATED (found empirically: a 5000 m outdoor probe leg past the
        // one loaded landblock's synthetic terrain patch reached its target
        // by running unobstructed through unmapped space). This is a harness
        // scope gap (we haven't loaded that geometry), never a real physics
        // outcome, so it fails loud as NoGround instead of a silent pass.
        if !point_has_coverage(env, &cur) {
            return (false, cur, speeds, Some(FailureKind::NoGround));
        }
    }
    // out of slices without arriving = stalled
    let g = cur.global_coords();
    let arrived = ((tgt_world.x - g.x).powi(2) + (tgt_world.y - g.y).powi(2)).sqrt() <= ARRIVE_M;
    let covered = ((g.x - start_g.x).powi(2) + (g.y - start_g.y).powi(2)).sqrt();
    let kind = if arrived {
        None
    } else if covered < 0.5 {
        Some(FailureKind::Wall) // never made meaningful progress — an immediate block
    } else {
        Some(FailureKind::Timeout) // made progress but the budget ran out
    };
    if std::env::var("RV_DEBUG_STALL").is_ok() && kind.is_some() {
        let lb_top16 = cur.landblock_id.0 & 0xFFFF_0000;
        let seed = WorldPosition { landblock_id: Guid(lb_top16 | 0x0100), coords: cur.coords, rotation: cur.rotation };
        let resolved_cell = env.scene.current_cell(&seed);
        eprintln!("  [RV_DEBUG_STALL] stalled cell={resolved_cell:#010x} pos_local=({:.2},{:.2},{:.2})", cur.coords.x, cur.coords.y, cur.coords.z);
    }
    (arrived, cur, speeds, kind)
}

/// SELF-DETERMINED indoor test (2026-07-20 corpus note): does `raw`'s world
/// point fall inside an EnvCell the loaded scene actually has geometry for?
/// The JS nav importer has no EnvCell concept and always emits
/// `indoor:false` on every corpus leg, so that flag is never trustworthy —
/// this asks the SAME question `SpatialScene::current_cell`'s indoor branch
/// answers for a live arrival: seed an indoor-sentinel pose at this exact
/// world point and let the cell-membership/AABB scan (over cells actually
/// resident in this landblock) decide. `current_cell` returns the seed
/// UNCHANGED when nothing claims the point (scene.rs:1925) — that's our
/// "not indoors" signal; any OTHER returned id means a real resident EnvCell
/// contains this point.
fn point_is_indoor(scene: &SpatialScene, raw: &WorldPosition) -> bool {
    let lb_top16 = raw.landblock_id.0 & 0xFFFF_0000;
    let seed = WorldPosition { landblock_id: Guid(lb_top16 | 0x0100), coords: raw.coords, rotation: raw.rotation };
    let resolved = scene.current_cell(&seed);
    resolved != seed.landblock_id.0 && (resolved & 0xFFFF) >= 0x0100
}

/// Scene-coverage guard (see the call site in `walk_leg`): does this harness
/// actually have geometry loaded at `pose`'s current point? Indoor: a
/// resident EnvCell whose physics BSP is loaded. Outdoor: a resolvable
/// terrain height. `false` ⇒ the walker has stepped into unmapped space this
/// offline harness never populated — continuing to simulate there would be
/// collision-free by construction (an uncharted void), not a faithful
/// physics result.
fn point_has_coverage(env: &RouteEnv, pose: &WorldPosition) -> bool {
    if point_is_indoor(&env.scene, pose) {
        let lb_top16 = pose.landblock_id.0 & 0xFFFF_0000;
        let seed = WorldPosition { landblock_id: Guid(lb_top16 | 0x0100), coords: pose.coords, rotation: pose.rotation };
        let cell = env.scene.current_cell(&seed);
        return env.scene.cell_physics_bsp(cell).is_some();
    }
    let g = pose.global_coords();
    env.terrain_height_at(g.x, g.y).is_some()
}

/// Resolve (and re-ground) a raw teleported/anchor pose. Indoor/outdoor is
/// SELF-DETERMINED via `point_is_indoor` (never the JSON flag — see its
/// doc). Indoor: run the SAME arrival placement search retail runs on
/// login/portal arrival (`faithful_find_placement_position` — task-#13
/// frame-audit function, `global_coords()` lift + `scene.current_cell` cell
/// resolution + step-down settle). Outdoor: snap Z to the terrain grid.
/// `Err(())` ⇒ NO-GROUND — the offline scene has no resident geometry (cell
/// BSP, or terrain grid) at this point, so validation refuses to guess
/// rather than silently pass a route through unloaded space (a corpus route
/// outside the landblocks this harness has populated legitimately reports
/// this — it is a scene-coverage gap, never a physics-engine failure).
fn anchor_pose(env: &RouteEnv, raw: &WorldPosition, object: &ObjectInfo) -> Result<WorldPosition, ()> {
    let lb_top16 = raw.landblock_id.0 & 0xFFFF_0000;
    if point_is_indoor(&env.scene, raw) {
        let seed = WorldPosition { landblock_id: Guid(lb_top16 | 0x0100), coords: raw.coords, rotation: raw.rotation };
        return match faithful_find_placement_position(env, &seed, object, &gates()) {
            Some(outcome) => Ok(outcome.pose),
            None => Err(()),
        };
    }
    let g = raw.global_coords();
    match env.terrain_height_at(g.x, g.y) {
        Some(h) => {
            let mut p = WorldPosition { landblock_id: Guid(lb_top16), coords: raw.coords, rotation: raw.rotation };
            p.coords.z = h;
            Ok(p)
        }
        None => Err(()),
    }
}

/// Per-leg failure detail for the batch report (SPEC W2.6 item 4).
#[derive(serde::Serialize, Clone)]
struct LegFailureDetail {
    leg_index: usize,
    kind: String,
    start: (f32, f32, f32),
    end: (f32, f32, f32),
    target: (f32, f32, f32),
    distance_achieved: f32,
    distance_required: f32,
}

struct RouteVerdict {
    result: Result<(), (usize, FailureKind)>,
    speeds: Vec<f32>,
    skipped_jump: usize,
    skipped_recall: usize,
    failure_detail: Option<LegFailureDetail>,
}

/// Validate a whole route: walk legs in order, return Ok(()) if all reach, or
/// Err((leg_index, kind)) at the first stall/no-ground. Portal/jump/recall
/// legs are teleport re-anchors (SPEC W2.6 item 2): position reset + re-ground
/// via `anchor_pose`, never claimed as walked.
fn validate_route(env: &RouteEnv, legs: &[Leg]) -> RouteVerdict {
    if legs.is_empty() {
        return RouteVerdict { result: Ok(()), speeds: Vec::new(), skipped_jump: 0, skipped_recall: 0, failure_detail: None };
    }
    let object = ObjectInfo::for_local_player(None, None, true, Guid(1));
    let start_raw = pose(legs[0].cell, legs[0].x, legs[0].y, legs[0].z);
    let mut cur = match anchor_pose(env, &start_raw, &object) {
        Ok(p) => p,
        Err(()) => {
            eprintln!("  leg 0: NO-GROUND at route start ({:.2},{:.2},{:.2})", legs[0].x, legs[0].y, legs[0].z);
            return RouteVerdict {
                result: Err((0, FailureKind::NoGround)),
                speeds: Vec::new(),
                skipped_jump: 0,
                skipped_recall: 0,
                failure_detail: Some(LegFailureDetail {
                    leg_index: 0,
                    kind: FailureKind::NoGround.as_str().into(),
                    start: (legs[0].x, legs[0].y, legs[0].z),
                    end: (legs[0].x, legs[0].y, legs[0].z),
                    target: (legs[0].x, legs[0].y, legs[0].z),
                    distance_achieved: 0.0,
                    distance_required: 0.0,
                }),
            };
        }
    };
    let mut all_speeds = Vec::new();
    let mut skipped_jump = 0usize;
    let mut skipped_recall = 0usize;

    for i in 1..legs.len() {
        let leg = &legs[i];
        match leg.kind {
            LegKind::Portal | LegKind::JumpSkip | LegKind::RecallSkip => {
                let raw = pose(leg.cell, leg.x, leg.y, leg.z);
                match anchor_pose(env, &raw, &object) {
                    Ok(p) => {
                        let label = match leg.kind {
                            LegKind::Portal => "PORTAL-REANCHOR",
                            LegKind::JumpSkip => "SKIPPED-JUMP",
                            LegKind::RecallSkip => "SKIPPED-RECALL",
                            LegKind::Walk => unreachable!(),
                        };
                        eprintln!("  leg {i}: {label} -> ({:.2},{:.2},{:.2})", leg.x, leg.y, leg.z);
                        match leg.kind {
                            LegKind::JumpSkip => skipped_jump += 1,
                            LegKind::RecallSkip => skipped_recall += 1,
                            _ => {}
                        }
                        cur = p;
                    }
                    Err(()) => {
                        eprintln!("  leg {i}: NO-GROUND on teleport re-anchor ({:.2},{:.2},{:.2})", leg.x, leg.y, leg.z);
                        return RouteVerdict {
                            result: Err((i, FailureKind::NoGround)),
                            speeds: all_speeds,
                            skipped_jump,
                            skipped_recall,
                            failure_detail: Some(LegFailureDetail {
                                leg_index: i,
                                kind: FailureKind::NoGround.as_str().into(),
                                start: (0.0, 0.0, 0.0),
                                end: (0.0, 0.0, 0.0),
                                target: (leg.x, leg.y, leg.z),
                                distance_achieved: 0.0,
                                distance_required: 0.0,
                            }),
                        };
                    }
                }
            }
            LegKind::Walk => {
                let from_g = cur.global_coords();
                let target_g = pose(leg.cell, leg.x, leg.y, leg.z).global_coords();
                let dist = ((target_g.x - from_g.x).powi(2) + (target_g.y - from_g.y).powi(2)).sqrt();
                // Corrupt/mis-tagged waypoint guard — see IMPLAUSIBLE_LEG_DISTANCE_M's
                // doc. Fails immediately, never enters the slice loop (never
                // computes/spends a budget), so a corrupted coordinate can't hang
                // the batch regardless of any scene/coverage edge case.
                if dist > IMPLAUSIBLE_LEG_DISTANCE_M {
                    eprintln!("  leg {i}: {dist:.1}m -> IMPLAUSIBLE (> {IMPLAUSIBLE_LEG_DISTANCE_M}m cap) — treated as corrupt route data, not walked");
                    return RouteVerdict {
                        result: Err((i, FailureKind::ImplausibleLeg)),
                        speeds: all_speeds,
                        skipped_jump,
                        skipped_recall,
                        failure_detail: Some(LegFailureDetail {
                            leg_index: i,
                            kind: FailureKind::ImplausibleLeg.as_str().into(),
                            start: (from_g.x, from_g.y, from_g.z),
                            end: (from_g.x, from_g.y, from_g.z),
                            target: (target_g.x, target_g.y, target_g.z),
                            distance_achieved: 0.0,
                            distance_required: dist,
                        }),
                    };
                }
                // budget slices by leg length (+headroom): ~ dist/RUN_SPEED frames × 3
                let budget = ((dist / RUN_SPEED / DT) as u32 * 3).max(60);
                let (arrived, end, speeds, fail) = walk_leg(env, cur, target_g, budget);
                all_speeds.extend(speeds);
                let end_g = end.global_coords();
                eprintln!(
                    "  leg {i}: {:.1}m -> {} ({} slices budget), end=({:.2},{:.2},{:.2})",
                    dist,
                    if arrived { "REACHED" } else { "STALLED" },
                    budget,
                    end.coords.x,
                    end.coords.y,
                    end.coords.z
                );
                if !arrived {
                    let kind = fail.unwrap_or(FailureKind::Timeout);
                    let covered = ((end_g.x - from_g.x).powi(2) + (end_g.y - from_g.y).powi(2)).sqrt();
                    return RouteVerdict {
                        result: Err((i, kind)),
                        speeds: all_speeds,
                        skipped_jump,
                        skipped_recall,
                        failure_detail: Some(LegFailureDetail {
                            leg_index: i,
                            kind: kind.as_str().into(),
                            start: (from_g.x, from_g.y, from_g.z),
                            end: (end_g.x, end_g.y, end_g.z),
                            target: (target_g.x, target_g.y, target_g.z),
                            distance_achieved: covered,
                            distance_required: dist,
                        }),
                    };
                }
                cur = end;
            }
        }
    }
    RouteVerdict { result: Ok(()), speeds: all_speeds, skipped_jump, skipped_recall, failure_detail: None }
}

// ── scene builders ──────────────────────────────────────────────────────────
//
// [CORRECTION 2026-07-20 (corpus generalization pass): the prior version of
// this section hardcoded ONE indoor scene (the Holtburg grocer, Environment
// 840, cells 016A..016E) and a synthetic flat outdoor terrain patch, with a
// doc comment claiming "holtburger-dat has no parser [for LandBlockInfo's
// per-cell height-byte grid] yet". VERIFIED FALSE: `holtburger_dat::landblock`
// already carries a complete, unit-tested `CellLandblock` parser (terrain
// heights + terrain/road/scenery bit-packing) and `LandblockInfo` parser
// (num_cells, `objects: Vec<Stab>` outdoor loose statics, `buildings:
// Vec<BuildInfo>`) — this section now uses both for real. The scene builder
// below is now GENERIC over any landblock set, ported from the wasm client's
// `fetchEnvCellsInLandblock` / `populateStaticsAabbsForLandblock` /
// `populateBuildingAabbsForLandblock` (apps/holtburger-web/src/lib.rs), which
// share this exact three-record-per-landblock shape (terrain @ `lb|0xFFFF`,
// LandblockInfo @ `lb|0xFFFE`, EnvCells @ `lb|(0x0100+i)` for `i` in
// `0..num_cells`).

/// Retail order (`0x65` Resting → `0` → first) static placement-frame
/// resolution for a stab's SetupModel — mirrors
/// `apps/holtburger-web/src/lib.rs::resolve_static_placement_frame` with
/// `retail_order=true` (the LIVE DEFAULT since 2026-06-27, docs/url-flags.md
/// `placementId`) and `wire_placement=None` (stabs never carry a server wire
/// placement id — that's `PhysicsDesc.animation_frame` for dynamic entities).
fn resolve_stab_placement_frame(setup: &SetupModel) -> Option<&holtburger_dat::file_type::setup_model::PlacementType> {
    setup
        .placement_frames
        .get(&0x65)
        .or_else(|| setup.placement_frames.get(&0))
        .or_else(|| setup.placement_frames.values().next())
}

/// Resolve ONE placed model (`model_id`'s top byte `0x01` plain GfxObj or
/// `0x02` SetupModel) into its precise world-frame physics BSP part(s), at
/// `world_origin`/`world_orientation`. Shared by THREE DAT placement shapes
/// that all carry the identical `(id, landblock-local frame)` structure —
/// EnvCell furniture (`EnvCell.static_objects: Vec<env_cell::Stab>`), outdoor
/// loose statics (`LandblockInfo.objects: Vec<landblock::Stab>` — trees,
/// rocks, signposts), and outdoor buildings (`LandblockInfo.buildings:
/// Vec<BuildInfo>`, keyed by `model_id`) — only the placement FRAME source
/// and the scene INSERT sink differ per caller (indoor:
/// `insert_cell_static_physics_bsp` keyed by cell id; outdoor:
/// `insert_static_physics_bsp` keyed by landblock high word), so this
/// extracts the identical 0x01/0x02 resolution math ported from the live
/// wasm client's Stab->Setup->GfxObj walk
/// (`walk_setup_parts_with_geom_and_bsp` + lib.rs ~18018-18110/14745-14790,
/// landed 2026-06-28/2026-06-30).
fn resolve_placement_physics_bsps(portal: &DatDatabase, model_id: u32, world_origin: Vector3, world_orientation: Quaternion) -> Vec<CellPhysicsBsp> {
    let mut out = Vec::new();
    match (model_id >> 24) as u8 {
        0x01 => {
            // Plain GfxObj — insert its physics BSP directly at the
            // placement's world frame (mirrors lib.rs ~18018-18063).
            let Ok(bytes) = portal.get_file_by_key(ResourceKey::new("eor/portal", model_id)) else { return out };
            let Ok(gfx) = GfxObj::unpack(&mut Cursor::new(&bytes)) else { return out };
            let Some(tree) = &gfx.physics_bsp else { return out };
            if gfx.physics_polygons.is_empty() {
                return out;
            }
            let polys = resolve_cell_physics_polygons(&gfx.physics_polygons, |vid| {
                gfx.vertex_array.vertices.get(&vid).map(|sw| Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z))
            });
            if polys.is_empty() {
                return out;
            }
            out.push(CellPhysicsBsp { tree: tree.clone(), polys, origin: world_origin, orientation: world_orientation, scale: 1.0 });
        }
        0x02 => {
            // SetupModel (furniture assemblies / multi-part buildings) — walk
            // each part, resolve its static placement frame + default_scale,
            // and compose the part frame with the placement's world frame
            // (mirrors lib.rs ~18065-18110 / walk_setup_parts_with_geom_and_bsp).
            let Ok(bytes) = portal.get_file_by_key(ResourceKey::new("eor/portal", model_id)) else { return out };
            let Ok(setup) = SetupModel::unpack(&mut Cursor::new(&bytes)) else { return out };
            let placement = resolve_stab_placement_frame(&setup);
            for (pi, &part_id) in setup.parts.iter().enumerate() {
                // The live walker only ever descends into plain GfxObj parts
                // (top byte 0x01) — SetupModel parts referencing another
                // SetupModel don't occur in practice and aren't walked there
                // either; match that here.
                if (part_id >> 24) as u8 != 0x01 {
                    continue;
                }
                let Ok(part_bytes) = portal.get_file_by_key(ResourceKey::new("eor/portal", part_id)) else { continue };
                let Ok(gfx) = GfxObj::unpack(&mut Cursor::new(&part_bytes)) else { continue };
                let Some(tree) = &gfx.physics_bsp else { continue };
                if gfx.physics_polygons.is_empty() {
                    continue;
                }
                let (offset, rot) = placement
                    .filter(|p| pi < p.anim_frame.frames.len())
                    .map(|p| (p.anim_frame.frames[pi].origin, p.anim_frame.frames[pi].orientation))
                    .unwrap_or((Vector3::zero(), Quaternion::identity()));
                let scale = setup.default_scale.get(pi).copied();
                let polys = resolve_cell_physics_polygons(&gfx.physics_polygons, |vid| {
                    gfx.vertex_array.vertices.get(&vid).map(|sw| {
                        let mut v = Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z);
                        if let Some(s) = scale {
                            v.x *= s.x;
                            v.y *= s.y;
                            v.z *= s.z;
                        }
                        v
                    })
                });
                if polys.is_empty() {
                    continue;
                }
                let pr = world_orientation.rotate_vector(offset);
                let wo = Vector3::new(world_origin.x + pr.x, world_origin.y + pr.y, world_origin.z + pr.z);
                let wq = world_orientation.multiply(rot);
                out.push(CellPhysicsBsp { tree: tree.clone(), polys, origin: wo, orientation: wq, scale: 1.0 });
            }
        }
        _ => {}
    }
    out
}

/// Per-scene-build memo of a model's LOCAL (unplaced) resolved physics parts,
/// keyed by `model_id`. A `Rc` so a cache hit is a cheap refcount bump before
/// the (still real, but now in-memory-only) per-instance transform clone —
/// see `resolve_placement_physics_bsps_cached`.
///
/// Perf note (corpus batch, 2026-07-20): a first full-corpus run without this
/// cache took >9.5 minutes to get through only 3 of ~49 routes before being
/// killed — a busy landblock's common models (a generic chair/tree/signpost)
/// are placed as EnvCell/LandblockInfo stabs HUNDREDS of times, and every
/// placement was independently re-fetching + re-decompressing + re-parsing +
/// re-resolving the SAME `client_portal.dat` record. This cache fetches/parses
/// each distinct `model_id` exactly ONCE per scene build (shared across every
/// landblock/cell in that build, since the same GfxObj/SetupModel recurs
/// across landblocks too), then reuses the resolved tree + polygon map for
/// every subsequent instance — only the (cheap) world-frame offset/rotation
/// and a Clone of the already-parsed data repeat per placement.
type ModelBspCache = HashMap<u32, Rc<Vec<CellPhysicsBsp>>>;

/// Cached wrapper around `resolve_placement_physics_bsps`: resolves
/// `model_id`'s LOCAL parts (world_origin=0, world_orientation=identity) ONCE
/// via the cache, then composes each cached local part's (origin=offset,
/// orientation=rot) with this instance's real world placement — identical
/// composition math to the 0x02 arm above (`wo = world_origin + rotate(world_orientation,
/// offset)`, `wq = world_orientation * rot`), which degenerates correctly for
/// the 0x01 case too (offset=zero, rot=identity ⇒ wo=world_origin, wq=world_orientation).
fn resolve_placement_physics_bsps_cached(cache: &mut ModelBspCache, portal: &DatDatabase, model_id: u32, world_origin: Vector3, world_orientation: Quaternion) -> Vec<CellPhysicsBsp> {
    let local = cache
        .entry(model_id)
        .or_insert_with(|| Rc::new(resolve_placement_physics_bsps(portal, model_id, Vector3::zero(), Quaternion::identity())))
        .clone();
    local
        .iter()
        .map(|part| {
            let pr = world_orientation.rotate_vector(part.origin);
            let wo = Vector3::new(world_origin.x + pr.x, world_origin.y + pr.y, world_origin.z + pr.z);
            let wq = world_orientation.multiply(part.orientation);
            CellPhysicsBsp { tree: part.tree.clone(), polys: part.polys.clone(), origin: wo, orientation: wq, scale: 1.0 }
        })
        .collect()
}

/// Offline furniture-collision recursion (SPEC W2.6 item 3), ported from the
/// live wasm client's Stab->Setup->GfxObj physics walk
/// (`walk_setup_parts_with_geom_and_bsp` + the indoor stab loop's `0x01`/`0x02`
/// arms, apps/holtburger-web/src/lib.rs ~18018-18110, landed 2026-06-28). Each
/// static object (table, shelf, counter, …) placed in the EnvCell gets its
/// PRECISE physics BSP staged into `scene.cell_static_physics_bsp` at its real
/// world placement, so offline validation collides indoor furniture exactly
/// like the live client. Returns (parts_with_bsp, polygon_count) for the
/// caller's parity log.
///
/// Frame: stab frames are LANDBLOCK-local already (2026-07-20 frame audit) —
/// `stab.position.origin + (lb_x, lb_y)` directly, NOT further composed with
/// the cell's own origin (that double-transformed furniture out of its room,
/// the exact bug the frame audit fixed live).
fn populate_cell_furniture(
    scene: &mut SpatialScene,
    cell_id: u32,
    envcell: &EnvCell,
    portal: &DatDatabase,
    lb_x: f32,
    lb_y: f32,
    model_cache: &mut ModelBspCache,
    door_policy: DoorPolicy,
) -> (usize, usize, usize) {
    let mut parts_with_bsp = 0usize;
    let mut poly_count = 0usize;
    let mut doors_skipped = 0usize;
    for stab in &envcell.static_objects {
        if door_policy == DoorPolicy::AssumeOpen && is_door_candidate_model(stab.stab_id) {
            doors_skipped += 1;
            continue;
        }
        let world_origin = Vector3::new(stab.position.origin.x + lb_x, stab.position.origin.y + lb_y, stab.position.origin.z);
        let world_orientation = stab.position.orientation;
        for bsp in resolve_placement_physics_bsps_cached(model_cache, portal, stab.stab_id, world_origin, world_orientation) {
            poly_count += bsp.polys.len();
            parts_with_bsp += 1;
            scene.insert_cell_static_physics_bsp(cell_id, bsp);
        }
    }
    let n = envcell.static_objects.len();
    if n > 0 {
        eprintln!("  cell {cell_id:#010x}: {n} static object(s) -> {parts_with_bsp} furniture BSP part(s), {poly_count} poly(s){}", if doors_skipped > 0 { format!(", {doors_skipped} door-candidate(s) skipped (AssumeOpen)") } else { String::new() });
    }
    (parts_with_bsp, poly_count, doors_skipped)
}

/// Outdoor twin of `populate_cell_furniture` (SPEC W2.6 item 2/3 generic
/// scene population): register precise physics BSPs for LandblockInfo-level
/// placements — either the loose-static list (`LandblockInfo.objects`: trees,
/// rocks, signposts, fences — mirrors
/// `populateStaticsAabbsForLandblock_impl`) or the buildings list
/// (`LandblockInfo.buildings`: houses/shops — mirrors
/// `populateBuildingAabbsForLandblock_impl`). Both feed the SAME
/// `scene.insert_static_physics_bsp(landblock_high, …)` sink (keyed by
/// landblock, not cell) that `bake_outdoor_static_overlap_for_landblock`
/// later distributes into per-outdoor-cell `cell_static_physics_bsp` entries
/// — the faithful outdoor narrow-phase `find_obj_collisions` reads.
///
/// Harness scope note (verified against `faithful_bridge.rs`/`transition.rs`):
/// the live wasm client ALSO registers buildings into a separate coarse
/// per-cell AABB index (`building_aabb_index`, walked via
/// `clamp_delta_against_buildings_with_normal`) that this native harness does
/// NOT populate — that index's builder (`walk_setup_parts_with_geom_and_physics`)
/// lives only in the wasm app crate (not a library this example can depend
/// on) and isn't reusable here without duplicating a large recursive Setup
/// walk. Routing buildings through the PRECISE per-object BSP path instead
/// (same as furniture/loose-statics, verified live in `find_obj_collisions`,
/// `faithful_bridge.rs:817`) gives equal-or-better collision fidelity for a
/// validation oracle's purposes (a real wall block is a real wall block); the
/// trade-off is that the coarse-AABB code path itself goes unexercised here,
/// and — same as the live client's own 0x02 multi-part building BSP staging
/// (`stage_bsp_02` doc, lib.rs ~14836-14842) — a building's door LEAF is just
/// another static Setup part with no open/closed state offline, so EVERY
/// building doorway this harness sees is effectively permanently CLOSED. A
/// route leg that stalls just past a `PORTAL-REANCHOR`/`SKIPPED-JUMP` into a
/// building, or right at a building's threshold, is this class of harness
/// artifact, not a genuine traversal gap — flagged explicitly in the corpus
/// report rather than silently folded into the wall/timeout counts.
fn populate_landblock_statics(
    scene: &mut SpatialScene,
    landblock_high: u32,
    placements: &[(u32, Vector3, Quaternion)],
    portal: &DatDatabase,
    lb_x: f32,
    lb_y: f32,
    label: &str,
    model_cache: &mut ModelBspCache,
    door_policy: DoorPolicy,
) -> (usize, usize, usize) {
    let mut parts_with_bsp = 0usize;
    let mut poly_count = 0usize;
    let mut doors_skipped = 0usize;
    for &(model_id, local_origin, orientation) in placements {
        if door_policy == DoorPolicy::AssumeOpen && is_door_candidate_model(model_id) {
            doors_skipped += 1;
            continue;
        }
        let world_origin = Vector3::new(local_origin.x + lb_x, local_origin.y + lb_y, local_origin.z);
        for bsp in resolve_placement_physics_bsps_cached(model_cache, portal, model_id, world_origin, orientation) {
            poly_count += bsp.polys.len();
            parts_with_bsp += 1;
            scene.insert_static_physics_bsp(landblock_high, bsp);
        }
    }
    if !placements.is_empty() {
        eprintln!("  lb {landblock_high:#010x}: {} {label}(s) -> {parts_with_bsp} BSP part(s), {poly_count} poly(s){}", placements.len(), if doors_skipped > 0 { format!(", {doors_skipped} door-candidate(s) skipped (AssumeOpen)") } else { String::new() });
    }
    (parts_with_bsp, poly_count, doors_skipped)
}

/// Populate ONE landblock's terrain height grid (real DAT `CellLandblock` @
/// `lb|0xFFFF`, SPEC W2.6 item 3 — corrects the prior no-parser claim, see the
/// section doc above) into the scene. Soft-skip (log + return false) rather
/// than fail the whole scene build: an ocean/off-map landblock may have no
/// terrain record, and a corpus route touching one is legitimately
/// `NoGround` there, not a harness crash.
fn populate_landblock_terrain(scene: &mut SpatialScene, cell_dat: &DatDatabase, landblock_high: u32) -> bool {
    let terrain_id = landblock_high | 0xFFFF;
    let Ok(bytes) = cell_dat.get_file(terrain_id) else {
        eprintln!("  lb {landblock_high:#010x}: no terrain record ({terrain_id:#010x}) — treated as unmapped");
        return false;
    };
    let Ok(cell) = CellLandblock::unpack(&bytes) else {
        eprintln!("  lb {landblock_high:#010x}: CellLandblock::unpack failed for {terrain_id:#010x}");
        return false;
    };
    let mut heights = [0.0_f32; 81];
    for x in 0..9 {
        for y in 0..9 {
            heights[x * 9 + y] = cell.get_height(x, y);
        }
    }
    scene.populate_terrain_heights(landblock_high, heights);
    true
}

/// Build a scene covering EXACTLY `lbs` (SPEC W2.6 item 4 — lazy per-route,
/// no global scene): for each landblock, populates real DAT terrain heights,
/// every resident EnvCell (physics BSP, cell-membership BSP, AABB, portal +
/// visible-cells graph edges, furniture recursion), outdoor loose statics,
/// and outdoor buildings (see `populate_landblock_statics` for the
/// buildings-via-precise-BSP scope note), then bakes the outdoor static
/// overlap so the faithful outdoor narrow-phase can see them. Best-effort per
/// record (a single malformed/missing EnvCell logs and is skipped, never
/// aborts the whole landblock) — this mirrors the live wasm client's
/// geom-audit stance (`fetchEnvCellsInLandblock`: "never silent" on partial
/// loads) rather than the old grocer-only builder's all-or-nothing `?` chain,
/// which is correct for a single hand-picked fixture but wrong for an
/// arbitrary corpus landblock that may have hundreds of cells.
fn build_scene_for_landblocks(portal: &DatDatabase, cell_dat: &DatDatabase, lbs: &BTreeSet<u32>, door_policy: DoorPolicy) -> (SpatialScene, usize) {
    let mut scene = SpatialScene::new();
    // Per-build memo of parsed Environment records, keyed by env DID — many
    // EnvCells (a dungeon's many rooms) usually share one Environment record;
    // mirrors lib.rs's S14/A5 `env_record_cache`.
    let mut env_cache: HashMap<u32, Option<Rc<Environment>>> = HashMap::new();
    // Per-build memo of resolved LOCAL model physics parts, keyed by
    // model_id (GfxObj/SetupModel DID) — shared by furniture, outdoor
    // statics, AND buildings, since the same signpost/chair/cottage model
    // recurs across cells and landblocks. See `ModelBspCache` doc for why
    // this is load-bearing for corpus-scale wall time, not just a nicety.
    let mut model_cache: ModelBspCache = HashMap::new();
    let mut total_cells = 0usize;
    let mut total_furniture_parts = 0usize;
    let mut total_static_parts = 0usize;
    let mut total_building_parts = 0usize;
    let mut total_doors_skipped = 0usize;

    for &lb in lbs {
        let lb_x = ((lb >> 24) & 0xFF) as f32 * 192.0;
        let lb_y = ((lb >> 16) & 0xFF) as f32 * 192.0;
        let has_terrain = populate_landblock_terrain(&mut scene, cell_dat, lb);

        let info_id = lb | 0xFFFE;
        let info = match cell_dat.get_file(info_id) {
            Ok(bytes) => match LandblockInfo::unpack(&bytes) {
                Ok(info) => Some(info),
                Err(e) => {
                    eprintln!("  lb {lb:#010x}: LandblockInfo::unpack failed for {info_id:#010x}: {e}");
                    None
                }
            },
            // No LandblockInfo — legitimately zero interior/statics/buildings
            // (open countryside, ocean). Not an error.
            Err(_) => None,
        };
        let Some(info) = info else { continue };

        for i in 0..info.num_cells {
            let cell_id = lb | (0x0100 + i);
            let bytes = match cell_dat.get_file(cell_id) {
                Ok(b) => b,
                Err(_) => continue, // geom-audit: promised by num_cells but missing — soft-skip
            };
            let envcell = match EnvCell::unpack(&mut Cursor::new(&bytes)) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("  lb {lb:#010x}: EnvCell::unpack failed for {cell_id:#010x}: {e}");
                    continue;
                }
            };
            let env_did = 0x0D00_0000 | (envcell.environment_id as u32);
            let environment = env_cache
                .entry(env_did)
                .or_insert_with(|| {
                    portal
                        .get_file(env_did)
                        .ok()
                        .and_then(|b| Environment::unpack(&mut Cursor::new(&b)).ok())
                        .map(Rc::new)
                })
                .clone();
            let Some(environment) = environment else { continue };
            let Some(cs) = environment.cells.get(&(envcell.cell_structure as u32)) else { continue };

            let origin = Vector3::new(envcell.position.origin.x + lb_x, envcell.position.origin.y + lb_y, envcell.position.origin.z);
            let orient = envcell.position.orientation;

            let resolved = resolve_cell_physics_polygons(&cs.physics_polygons, |vid| {
                cs.vertex_array.vertices.get(&vid).map(|sw| Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z))
            });
            if let Some(tree) = cs.physics_bsp.clone() {
                scene.insert_cell_physics_bsp(cell_id, CellPhysicsBsp { tree, polys: resolved, origin, orientation: orient, scale: 1.0 });
            }
            if let Some(tree) = cs.cell_bsp.clone() {
                scene.insert_cell_membership(cell_id, CellMembership { tree, origin, orientation: orient });
            }
            let mut aabb = Aabb::empty();
            for sw in cs.vertex_array.vertices.values() {
                let w = orient.rotate_vector(Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z)) + origin;
                aabb.expand_to_include_point(w);
            }
            if !aabb.is_empty() {
                let p = 0.1;
                scene.insert_cell_aabb(cell_id, Aabb::new(Vector3::new(aabb.min.x - p, aabb.min.y - p, aabb.min.z - p), Vector3::new(aabb.max.x + p, aabb.max.y + p, aabb.max.z + p)));
            }
            for pt in &envcell.portals {
                let other = lb | pt.other_cell_id as u32;
                if pt.other_cell_id != 0 && other != cell_id {
                    scene.insert_cell_portal(cell_id, other);
                }
            }
            for &vc in &envcell.visible_cells {
                let other = lb | vc as u32;
                if vc != 0 && other != cell_id {
                    scene.insert_cell_portal(cell_id, other);
                }
            }
            let (parts, _polys, doors_skipped) = populate_cell_furniture(&mut scene, cell_id, &envcell, portal, lb_x, lb_y, &mut model_cache, door_policy);
            total_furniture_parts += parts;
            total_doors_skipped += doors_skipped;
            total_cells += 1;
        }

        let static_placements: Vec<(u32, Vector3, Quaternion)> =
            info.objects.iter().map(|s| (s.id, s.frame.origin, s.frame.orientation)).collect();
        let (static_parts, _, doors_skipped) = populate_landblock_statics(&mut scene, lb, &static_placements, portal, lb_x, lb_y, "outdoor static", &mut model_cache, door_policy);
        total_static_parts += static_parts;
        total_doors_skipped += doors_skipped;

        let building_placements: Vec<(u32, Vector3, Quaternion)> =
            info.buildings.iter().map(|b| (b.model_id, b.frame.origin, b.frame.orientation)).collect();
        let (building_parts, _, doors_skipped) = populate_landblock_statics(&mut scene, lb, &building_placements, portal, lb_x, lb_y, "building", &mut model_cache, door_policy);
        total_building_parts += building_parts;
        total_doors_skipped += doors_skipped;

        // Distribute this landblock's raw (landblock-keyed) static/building
        // BSPs into the per-outdoor-cell overlap index the faithful outdoor
        // narrow-phase actually reads (`cell_static_physics_bsp`). Requires
        // terrain residency (the bake's loading-virus bound) — skip
        // gracefully when this landblock had no terrain record.
        if has_terrain && (static_parts > 0 || building_parts > 0) {
            scene.bake_outdoor_static_overlap_for_landblock(lb, true);
        }
    }
    eprintln!(
        "  scene: {} landblock(s), {total_cells} EnvCell(s), {total_furniture_parts} furniture BSP part(s), {total_static_parts} outdoor-static BSP part(s), {total_building_parts} building BSP part(s) [door_policy={door_policy:?}, {total_doors_skipped} door-candidate(s) skipped]",
        lbs.len()
    );
    (scene, total_doors_skipped)
}

// ── hb-route-v1 JSON loader ─────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct RouteFileLegMeta {
    #[serde(default, rename = "navType")]
    nav_type: Option<String>,
}

#[derive(serde::Deserialize)]
struct RouteFileLeg {
    x: f32,
    y: f32,
    z: f32,
    #[serde(default)]
    portal: bool,
    // Parsed but intentionally NOT used for leg-frame/classification — the JS
    // nav importer has no EnvCell concept and emits `indoor:false` on every
    // corpus leg. Indoor-ness is SELF-DETERMINED from loaded scene geometry
    // (`point_is_indoor`, called from `anchor_pose`) instead. Kept in the
    // struct only for schema compatibility / future diagnostic use.
    #[serde(default)]
    #[allow(dead_code)]
    indoor: bool,
    #[serde(default)]
    meta: Option<RouteFileLegMeta>,
}

#[derive(serde::Deserialize)]
struct RouteFile {
    schema: String,
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    source: String,
    #[serde(default, rename = "fileName")]
    #[allow(dead_code)]
    file_name: String,
    #[serde(default, rename = "navType")]
    #[allow(dead_code)]
    nav_type: String,
    legs: Vec<RouteFileLeg>,
    #[serde(default)]
    warnings: Vec<String>,
}

const SUPPORTED_SCHEMA: &str = "hb-route-v1";

fn load_route_file(path: &Path) -> Result<(RouteFile, Vec<Leg>), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read error: {e}"))?;
    let route: RouteFile = serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {e}"))?;
    if route.schema != SUPPORTED_SCHEMA {
        return Err(format!("unsupported schema {:?} (expected {SUPPORTED_SCHEMA:?})", route.schema));
    }
    if route.legs.is_empty() {
        return Err("route has zero legs".to_string());
    }
    for w in &route.warnings {
        eprintln!("  [importer warning] {w}");
    }
    let legs: Vec<Leg> = route
        .legs
        .iter()
        .map(|l| {
            let nav_type = l.meta.as_ref().and_then(|m| m.nav_type.as_deref());
            leg_from_world(l.x, l.y, l.z, LegKind::from_json(l.portal, nav_type))
        })
        .collect();
    Ok((route, legs))
}

/// A batch directory can carry non-route JSON siblings (e.g. the importer's
/// own `_summary.json`, which has no `schema` field and used to surface as a
/// spurious `_summary ERROR: JSON parse error: missing field 'schema'` row —
/// harmless but noisy, and not what a batch run is meant to report on). A
/// leading `_` is this corpus's own convention for "not a route file" (see
/// `nav_batch_import.cjs`'s `_summary.json` output) — skip it at the glob
/// rather than loading it and letting `load_route_file`'s schema check turn
/// it into a fake per-route ERROR entry.
fn collect_json_files(path: &Path) -> Vec<PathBuf> {
    if path.is_dir() {
        let mut files: Vec<PathBuf> = std::fs::read_dir(path)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
                    .filter(|p| !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('_')))
                    .collect()
            })
            .unwrap_or_default();
        files.sort();
        files
    } else {
        vec![path.to_path_buf()]
    }
}

// ── batch report ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct RouteReport {
    file: String,
    name: String,
    legs_total: usize,
    verdict: String,
    skipped_jump: usize,
    skipped_recall: usize,
    wall_time_ms: u128,
    measured_speed_median: Option<f32>,
    failure: Option<LegFailureDetail>,
    error: Option<String>,
    /// True when the Blind pass failed on a Wall/Timeout (a blocking-geometry
    /// shape) and the `AssumeOpen` door-state retry ran at all.
    door_retry_attempted: bool,
    /// Count of 0x02-class (multi-part SetupModel) placements — the only
    /// DAT-derivable "might be a door" signal, see `DoorPolicy` doc — skipped
    /// across the route's whole landblock set when the retry ran. Present
    /// (possibly 0) whenever `door_retry_attempted`; 0 when no retry ran.
    /// A retry that ran with `door_candidates_skipped == 0` (or > 0 but
    /// `door_retry_helped == false`) is real negative evidence: the blocking
    /// geometry at the stall was NOT a Stab/static/building placement this
    /// harness can identify at all — see `RV_DEBUG_STALL=1` to find exactly
    /// which resident EnvCell it was (frozen-tomb: 0x77E701E1, zero static
    /// objects — a structural room-wall/portal blocker, not a Stab door,
    /// most likely the Deewain-lore class of SERVER-authored geometry no
    /// DAT-side simulation can ever see).
    door_candidates_skipped: usize,
    /// True when the retry's verdict is strictly no worse than Blind's
    /// (validates, or fails at a later leg) and was therefore adopted as the
    /// reported verdict.
    door_retry_helped: bool,
}

#[derive(serde::Serialize)]
struct BatchReport {
    generated_unix_secs: u64,
    routes: Vec<RouteReport>,
    validated_count: usize,
    failed_count: usize,
    skipped_count: usize,
    error_count: usize,
}

fn median_speed(speeds: &[f32]) -> Option<f32> {
    if speeds.is_empty() {
        return None;
    }
    let mut s = speeds.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(s[s.len() / 2])
}

/// Pure decision for the door-state retry (gap 3, see `run_one_route`'s
/// door-retry section): should the `AssumeOpen` retry's verdict replace the
/// `Blind` pass's verdict for reporting, and did it actually HELP? "No
/// worse" = `retry` validates, or fails at a leg index >= `blind`'s failing
/// leg — `AssumeOpen` only ever REMOVES collision relative to `Blind`, so it
/// can never make genuine progress worse; a retry that somehow fails
/// EARLIER than `Blind` would indicate a harness inconsistency, not a
/// legitimate result, and is rejected outright (kept `Blind`, not adopted).
/// Returns `(adopt_retry, helped)` — `helped` is only ever true when
/// `adopt_retry` is.
fn door_retry_verdict(blind: &Result<(), (usize, FailureKind)>, retry: &Result<(), (usize, FailureKind)>) -> (bool, bool) {
    let blind_fail_leg = match blind { Err((n, _)) => *n, Ok(()) => usize::MAX };
    let retry_fail_leg = match retry { Err((n, _)) => *n, Ok(()) => usize::MAX };
    if retry_fail_leg >= blind_fail_leg {
        (true, retry_fail_leg > blind_fail_leg || retry.is_ok())
    } else {
        (false, false)
    }
}

/// Run ONE route file end-to-end: load, discover its touched landblocks
/// (SPEC W2.6 item 1), build a scene covering EXACTLY that set (item 2/3,
/// lazily — dropped when this function returns, item 4's "load lazily per
/// route" memory guard), then validate. A route whose discovered landblock
/// set exceeds `MAX_LBS_PER_ROUTE` is reported `SKIPPED-SCOPE` rather than
/// attempted (item 4's "skip-with-reason" choice for outsized outdoor
/// epics) — loud, never a silent partial load.
fn run_one_route(portal: &DatDatabase, cell_dat: &DatDatabase, path: &Path) -> RouteReport {
    let file = path.display().to_string();
    let started = std::time::Instant::now();
    let (route, legs) = match load_route_file(path) {
        Err(e) => {
            return RouteReport {
                file,
                name: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                legs_total: 0,
                verdict: "ERROR".to_string(),
                skipped_jump: 0,
                skipped_recall: 0,
                wall_time_ms: started.elapsed().as_millis(),
                measured_speed_median: None,
                failure: None,
                error: Some(e),
                door_retry_attempted: false,
                door_candidates_skipped: 0,
                door_retry_helped: false,
            };
        }
        Ok(v) => v,
    };
    eprintln!("route_validate: {:?} — {} legs ({})", route.name, legs.len(), file);

    let lbs = discover_landblocks(&legs);
    eprintln!("  discovered {} landblock(s): {:#010x?}", lbs.len(), lbs);
    if lbs.len() > MAX_LBS_PER_ROUTE {
        let verdict_str = format!("SKIPPED-SCOPE ({} landblocks > {MAX_LBS_PER_ROUTE} cap)", lbs.len());
        eprintln!("  -> {verdict_str}");
        return RouteReport {
            file,
            name: route.name,
            legs_total: legs.len(),
            verdict: verdict_str,
            skipped_jump: 0,
            skipped_recall: 0,
            wall_time_ms: started.elapsed().as_millis(),
            measured_speed_median: None,
            failure: None,
            error: None,
            door_retry_attempted: false,
            door_candidates_skipped: 0,
            door_retry_helped: false,
        };
    }

    let (scene, _) = build_scene_for_landblocks(portal, cell_dat, &lbs, DoorPolicy::Blind);
    let env = RouteEnv { scene };
    let mut verdict = validate_route(&env, &legs);
    let mut door_retry_attempted = false;
    let mut door_candidates_skipped = 0usize;
    let mut door_retry_helped = false;

    // Door-state retry (gap 3): a Wall/Timeout is the ONLY failure shape a
    // blocking door leaf could produce (NoGround/Wedge/ImplausibleLeg are not
    // about a solid obstruction — see `DoorPolicy` doc). Re-simulate the
    // WHOLE route once with door-candidate placements skipped; keep the retry
    // only if it does no worse (validates, or fails at a strictly later leg)
    // than the Blind pass — AssumeOpen can only remove collision, so a worse
    // outcome would mean a harness bug, not a legitimate result. Report the
    // skip count and outcome EVEN WHEN IT DIDN'T HELP: a retry that ran with
    // zero (or unhelpful) door-candidate placements is real negative evidence
    // that the blocking geometry wasn't a Stab/static/building this harness
    // can identify at all (see the field doc — that's the frozen-tomb case).
    let is_blocking_shape = matches!(verdict.result, Err((_, FailureKind::Wall)) | Err((_, FailureKind::Timeout)));
    if is_blocking_shape {
        door_retry_attempted = true;
        let (open_scene, skipped) = build_scene_for_landblocks(portal, cell_dat, &lbs, DoorPolicy::AssumeOpen);
        door_candidates_skipped = skipped;
        if skipped > 0 {
            let open_env = RouteEnv { scene: open_scene };
            let retry = validate_route(&open_env, &legs);
            eprintln!(
                "  door-retry: AssumeOpen ({skipped} door-candidate(s) skipped) -> {}",
                match retry.result { Ok(()) => "VALIDATED".to_string(), Err((n, _)) => format!("still FAILED-AT-LEG {n}") }
            );
            let (adopt, helped) = door_retry_verdict(&verdict.result, &retry.result);
            if adopt {
                door_retry_helped = helped;
                verdict = retry;
            }
        } else {
            eprintln!("  door-retry: 0 door-candidate placements in this route's scene — no DAT-derivable door object to bypass");
        }
    }

    let wall_time_ms = started.elapsed().as_millis();
    let door_suffix = if door_retry_helped {
        format!(", doors assumed open — {door_candidates_skipped} door-candidate(s) bypassed")
    } else if door_retry_attempted {
        format!(", door-retry attempted ({door_candidates_skipped} candidate(s)) — did not resolve, blocker not a DAT-derivable door object")
    } else {
        String::new()
    };
    let (verdict_str, failure) = match verdict.result {
        Ok(()) => (format!("VALIDATED ({} legs{door_suffix})", legs.len()), None),
        Err((n, kind)) => (format!("FAILED-AT-LEG {n} ({}{door_suffix})", kind.as_str()), verdict.failure_detail.clone()),
    };
    eprintln!("  -> {verdict_str}");
    RouteReport {
        file,
        name: route.name,
        legs_total: legs.len(),
        verdict: verdict_str,
        skipped_jump: verdict.skipped_jump,
        skipped_recall: verdict.skipped_recall,
        wall_time_ms,
        measured_speed_median: median_speed(&verdict.speeds),
        failure,
        error: None,
        door_retry_attempted,
        door_candidates_skipped,
        door_retry_helped,
    }
    // `env` (and its scene) drops here — the next route's `build_scene_for_landblocks`
    // starts from a fresh empty `SpatialScene`, never accumulating landblocks
    // across the batch.
}

fn write_batch_report(reports: &[RouteReport]) {
    let validated_count = reports.iter().filter(|r| r.verdict.starts_with("VALIDATED")).count();
    let failed_count = reports.iter().filter(|r| r.verdict.starts_with("FAILED")).count();
    let skipped_count = reports.iter().filter(|r| r.verdict.starts_with("SKIPPED")).count();
    let error_count = reports.iter().filter(|r| r.error.is_some()).count();
    let generated_unix_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);

    if let Err(e) = std::fs::create_dir_all(REPORT_DIR) {
        eprintln!("  [report] could not create {REPORT_DIR}: {e} (skipping report write)");
        print_table(reports, validated_count, failed_count, skipped_count, error_count);
        return;
    }

    let batch = BatchReport { generated_unix_secs, routes: reports.to_vec(), validated_count, failed_count, skipped_count, error_count };
    let json_path = format!("{REPORT_DIR}/validation-report-{generated_unix_secs}.json");
    match serde_json::to_string_pretty(&batch) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&json_path, text) {
                eprintln!("  [report] write failed for {json_path}: {e}");
            } else {
                println!("report: {json_path}");
            }
        }
        Err(e) => eprintln!("  [report] JSON serialize failed: {e}"),
    }

    let txt_path = format!("{REPORT_DIR}/validation-report-{generated_unix_secs}.txt");
    let table = render_table(reports, validated_count, failed_count, skipped_count, error_count);
    if let Err(e) = std::fs::write(&txt_path, &table) {
        eprintln!("  [report] write failed for {txt_path}: {e}");
    } else {
        println!("report: {txt_path}");
    }
    print!("{table}");
}

fn render_table(reports: &[RouteReport], validated: usize, failed: usize, skipped: usize, errors: usize) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "{:<40} {:<10} {:>5} {:>6} {:>6} {:>8}  verdict", "name", "legs", "skJ", "skR", "ms", "medv");
    for r in reports {
        let _ = writeln!(
            out,
            "{:<40} {:<10} {:>5} {:>6} {:>6} {:>8.2}  {}",
            truncate(&r.name, 40),
            r.legs_total,
            r.skipped_jump,
            r.skipped_recall,
            r.wall_time_ms,
            r.measured_speed_median.unwrap_or(0.0),
            r.verdict,
        );
        if let Some(f) = &r.failure {
            let _ = writeln!(
                out,
                "    leg {} [{}]: start=({:.2},{:.2},{:.2}) end=({:.2},{:.2},{:.2}) target=({:.2},{:.2},{:.2}) achieved={:.2}m/required={:.2}m",
                f.leg_index, f.kind, f.start.0, f.start.1, f.start.2, f.end.0, f.end.1, f.end.2, f.target.0, f.target.1, f.target.2, f.distance_achieved, f.distance_required
            );
        }
        if let Some(e) = &r.error {
            let _ = writeln!(out, "    error: {e}");
        }
    }
    let _ = writeln!(
        out,
        "-- {validated} validated / {failed} failed / {skipped} skipped-scope / {errors} error(s), {} route(s) total",
        reports.len()
    );
    out
}

fn print_table(reports: &[RouteReport], validated: usize, failed: usize, skipped: usize, errors: usize) {
    print!("{}", render_table(reports, validated, failed, skipped, errors));
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}

// ── built-in fixture (unchanged behavior when run with no CLI arg) ─────────

fn run_builtin_fixture(env: &RouteEnv) {
    // Built-in fixture route: the proven-walkable grocer traverse — start
    // grounded in the vestibule (0xA9B4016E) and walk NORTH across the seam
    // into the back room (0xA9B4016A). env840 proves this crossing grounds.
    let route = vec![
        Leg { cell: (GROCER_LB << 16) | 0x016E, x: 81.0, y: 33.0, z: 94.355, kind: LegKind::Walk },
        Leg { cell: (GROCER_LB << 16) | 0x016A, x: 81.0, y: 40.0, z: 94.0, kind: LegKind::Walk },
    ];

    eprintln!("route_validate: {} legs (built-in grocer fixture)", route.len());
    let verdict = validate_route(env, &route);

    // ETA calibration: median grounded slice speed should equal RUN_SPEED (4.0).
    if let Some(med) = median_speed(&verdict.speeds) {
        eprintln!(
            "  measured grounded speed: median {:.3} m/s over {} slices (expect ~{:.1} = run_rate×RUN_ANIM_SPEED)",
            med,
            verdict.speeds.len(),
            RUN_SPEED
        );
    }

    match verdict.result {
        Ok(()) => println!("VALIDATED: all {} legs ground-walked without stalling", route.len()),
        Err((n, kind)) => println!("FAILED-AT-LEG {n}: the route stalled on leg {n} ({})", kind.as_str()),
    }

    // Furniture-parity proof (SPEC W2.6 item 3): the grocer scene must have
    // registered at least one static-object physics BSP now that the
    // Stab->Setup->GfxObj recursion is ported (was always 0 under the old
    // stub).
    let furniture_count = env.scene.cell_static_physics_bsp_count();
    println!("FURNITURE-PARITY: {furniture_count} static physics BSP part(s) registered in the grocer scene (expect > 0)");
    assert!(furniture_count > 0, "furniture recursion regressed: 0 static physics BSPs registered for the grocer scene");

    // Negative self-check: an unreachable leg (target 60 m away through the
    // grocer walls, only 40 slices of budget) must report STALLED — proving the
    // failed-at-leg path fires, not just the happy path.
    let start = pose((GROCER_LB << 16) | 0x016E, 81.0, 33.0, 94.355);
    let unreachable_target = pose((GROCER_LB << 16) | 0x016E, 141.0, 33.0, 94.355).global_coords();
    let (arrived, _end, _s, _fail) = walk_leg(env, start, unreachable_target, 40);
    println!(
        "NEG-CHECK: unreachable leg -> {} (expect STALLED)",
        if arrived { "REACHED (unexpected!)" } else { "STALLED" }
    );
}

fn main() {
    let (portal, cell_dat) = match (DatDatabase::new(PORTAL_DAT), DatDatabase::new(CELL_DAT)) {
        (Ok(p), Ok(c)) => (p, c),
        _ => {
            println!("SKIP route_validate: base dats unavailable ({PORTAL_DAT} / {CELL_DAT})");
            return;
        }
    };

    match std::env::args().nth(1) {
        None => {
            // Built-in fixture: scene scoped to just the grocer's landblock
            // (via the SAME generic builder every corpus route now uses —
            // this is a regression check on the generic path itself, not a
            // separate hand-rolled one).
            let lbs = BTreeSet::from([GROCER_LB << 16]);
            let (scene, _) = build_scene_for_landblocks(&portal, &cell_dat, &lbs, DoorPolicy::Blind);
            let env = RouteEnv { scene };
            run_builtin_fixture(&env);
        }
        Some(arg) => {
            let path = PathBuf::from(&arg);
            let files = collect_json_files(&path);
            if files.is_empty() {
                println!("SKIP route_validate: no .json route files found at {arg}");
                return;
            }
            // Lazy per-route scene build (SPEC W2.6 item 4 memory guard):
            // `run_one_route` builds + drops its own scene, so at most ONE
            // route's landblock set is resident at a time regardless of how
            // many routes the batch covers.
            let reports: Vec<RouteReport> = files.iter().map(|f| run_one_route(&portal, &cell_dat, f)).collect();
            write_batch_report(&reports);
        }
    }
}

// ── door-state modeling unit tests (gap 3, HANDOFF-metanav-2026-07-20) ─────
#[cfg(test)]
mod door_state_tests {
    use super::*;
    use holtburger_dat::file_type::env_cell::Stab;
    use holtburger_dat::graphics::Frame;

    #[test]
    fn is_door_candidate_model_matches_the_02_multipart_setup_class_only() {
        // Plain GfxObj (0x01) — never a door candidate under this heuristic.
        assert!(!is_door_candidate_model(0x0100_1234));
        assert!(!is_door_candidate_model(0x01FF_FFFF));
        // Multi-part SetupModel (0x02) — the ONLY DAT-derivable "might be a
        // door" signal (mirrors the live client's `stage_bsp_02` gate).
        assert!(is_door_candidate_model(0x0200_0001));
        assert!(is_door_candidate_model(0x02AB_CDEF));
        // Other DAT filetypes (terrain, environments, …) are never candidates.
        assert!(!is_door_candidate_model(0x0000_0001));
        assert!(!is_door_candidate_model(0x0D00_0347));
        assert!(!is_door_candidate_model(0xFFFF_FFFF & !(0x02u32 << 24) | 0x0300_0000));
    }

    #[test]
    fn door_retry_verdict_adopts_a_validated_retry_as_helped() {
        let blind: Result<(), (usize, FailureKind)> = Err((47, FailureKind::Timeout));
        let retry: Result<(), (usize, FailureKind)> = Ok(());
        assert_eq!(door_retry_verdict(&blind, &retry), (true, true));
    }

    #[test]
    fn door_retry_verdict_adopts_a_later_leg_failure_as_helped() {
        // Retry still fails, but strictly further into the route than Blind
        // did — real progress, counts as helped (e.g. one door bypassed, a
        // different unrelated blocker further on).
        let blind: Result<(), (usize, FailureKind)> = Err((10, FailureKind::Wall));
        let retry: Result<(), (usize, FailureKind)> = Err((15, FailureKind::Timeout));
        assert_eq!(door_retry_verdict(&blind, &retry), (true, true));
    }

    #[test]
    fn door_retry_verdict_adopts_but_does_not_flag_helped_on_a_same_leg_failure() {
        // The frozen-tomb shape: AssumeOpen skipped placements, but none of
        // them were near the stall, so the retry fails at the EXACT same leg
        // (no worse, but not an improvement either) — adopted (harmless,
        // equivalent verdict) but NOT reported as "helped".
        let blind: Result<(), (usize, FailureKind)> = Err((47, FailureKind::Timeout));
        let retry: Result<(), (usize, FailureKind)> = Err((47, FailureKind::Timeout));
        assert_eq!(door_retry_verdict(&blind, &retry), (true, false));
    }

    #[test]
    fn door_retry_verdict_rejects_a_worse_retry() {
        // AssumeOpen can only REMOVE collision relative to Blind, so it
        // should never be able to fail EARLIER — if it somehow does, that is
        // a harness inconsistency, not a legitimate result: reject the
        // retry outright and keep Blind's verdict.
        let blind: Result<(), (usize, FailureKind)> = Err((10, FailureKind::Wall));
        let retry: Result<(), (usize, FailureKind)> = Err((3, FailureKind::Wall));
        assert_eq!(door_retry_verdict(&blind, &retry), (false, false));
    }

    #[test]
    fn populate_cell_furniture_assume_open_skips_0x02_stabs_but_keeps_0x01() {
        let Ok(portal) = DatDatabase::new(PORTAL_DAT) else {
            eprintln!("SKIP populate_cell_furniture_assume_open_skips_0x02_stabs_but_keeps_0x01: base dats unavailable");
            return;
        };
        // Synthetic EnvCell: one plain GfxObj Stab (0x01-class, a real
        // furniture model — resolvable, so it exercises the actual BSP
        // insertion path) and one fabricated 0x02-class Stab id that need
        // not even resolve (AssumeOpen must skip it BEFORE any DAT fetch).
        let mut scene = SpatialScene::new();
        let mut model_cache: ModelBspCache = HashMap::new();
        let envcell = EnvCell {
            id: 0x0170_0100,
            flags: 0,
            cell_id: 0x0170_0100,
            surfaces: vec![],
            environment_id: 0,
            cell_structure: 0,
            position: Frame { origin: Vector3::zero(), orientation: Quaternion::identity() },
            portals: vec![],
            visible_cells: vec![],
            static_objects: vec![
                Stab { stab_id: 0x0100_0002, position: Frame { origin: Vector3::zero(), orientation: Quaternion::identity() } },
                Stab { stab_id: 0x0299_9999, position: Frame { origin: Vector3::zero(), orientation: Quaternion::identity() } },
            ],
            restriction_obj: None,
        };
        let (_parts_blind, _polys_blind, skipped_blind) =
            populate_cell_furniture(&mut scene, 0x0170_0100, &envcell, &portal, 0.0, 0.0, &mut model_cache, DoorPolicy::Blind);
        assert_eq!(skipped_blind, 0, "Blind must never skip a placement regardless of model_id shape");

        let mut scene2 = SpatialScene::new();
        let mut model_cache2: ModelBspCache = HashMap::new();
        let (_parts_open, _polys_open, skipped_open) =
            populate_cell_furniture(&mut scene2, 0x0170_0100, &envcell, &portal, 0.0, 0.0, &mut model_cache2, DoorPolicy::AssumeOpen);
        assert_eq!(skipped_open, 1, "AssumeOpen must skip exactly the one 0x02-class stab");
    }

    #[test]
    fn collect_json_files_skips_underscore_prefixed_siblings() {
        let dir = std::env::temp_dir().join(format!("rv_door_state_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        std::fs::write(dir.join("_summary.json"), b"{}").unwrap();
        std::fs::write(dir.join("real-route.json"), b"{}").unwrap();
        std::fs::write(dir.join("also-real.json"), b"{}").unwrap();
        let files = collect_json_files(&dir);
        let names: Vec<String> = files.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
        assert!(!names.iter().any(|n| n.starts_with('_')), "must never include an underscore-prefixed file: {names:?}");
        assert_eq!(names.len(), 2, "must include exactly the two real route files: {names:?}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
