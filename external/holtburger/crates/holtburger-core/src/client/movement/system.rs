use super::common::{
    AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL, HUGE_QUANTUM, MAX_QUANTUM, MAX_VELOCITY, MIN_QUANTUM,
    PHYSICS_ENTRY_EPSILON, PLAYER_GROUND_FRICTION_PER_SEC, PLAYER_GROUND_FRICTION_RETAIL,
    PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ, PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC,
    RETAIL_MAX_QUANTUM, RUN_TURN_FACTOR, build_autonomous_position, build_jump,
    build_motion_state_raw_motion_state, build_move_to_state, build_raw_state_raw_motion_state,
    calc_friction,
    has_autonomous_position_sync_target, local_omega_for_state, local_velocity_for_state,
    normalize_heading, raw_motion_state_with_motion_style, signed_heading_delta,
};
use super::interp_state::{InterpretedForwardCommand, InterpretedState};
use super::jump_charge::{JumpChargeClock, JumpOutcome, JumpRefusal};
use super::motion_interp::{
    MotionInterp, MotionSideEffects, interpreted_velocity_for_state,
    leave_ground_velocity_for_state,
};
use super::motion_table_manager::{MotionTableEvent, MotionTableManager};
use super::move_to::{MoveToSteer, MoveToView, USE_MOVETO_DRIVER, WE_ACTION_CANCELLED};
use super::movement_manager::{MovementManager, MovementStruct, USE_UNPACK_MOVEMENT_SEMANTICS};
use super::params::MovementParameters;
use super::stall_recovery::MoveToStallRecovery;
use crate::client::movement_types::{
    AutonomousDriveIntent, ForwardLocomotion, MotionState, MotionStyle, MovementPacketMetadata,
    PlayerDriveIntent, SidestepLocomotion, Turn,
};
use anyhow::Result;
use holtburger_common::sequence::is_newer_u16;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::game_action::*;
use holtburger_protocol::messages::game_message::RawMotionState;
use holtburger_protocol::messages::movement::{InterpretedMotionCommand, MotionItem};
use holtburger_session::{ActionSink, Session};
use holtburger_world::SolveBodyInput;
use holtburger_world::spatial::{
    InterpStep, LocalDriveControl, LocalDriveGait, LocalStickyStep, PLAYER_CAPSULE_HEIGHT,
    PLAYER_CAPSULE_RADIUS, USE_STICKY_MANAGER,
};
use holtburger_world::{SpatialBodyId, WorldEvent, WorldState};
use std::collections::HashMap;
use std::time::Duration;
use web_time::Instant;

/// Physics deep-dive 2026-06-01 (gaps 1 + 7) — gate for the
/// clamp-and-subdivide integration loop in
/// [`MovementSystem::advance_local_pose_for_manual_drive`].
///
/// `true` (default): bound the raw per-frame `dt`, drop a
/// `HUGE_QUANTUM`-or-larger hitch, and integrate the frame as a
/// sequence of `<= MAX_QUANTUM` slices with a terminal-velocity clamp
/// and 2nd-order airborne integration — mirroring ACE's
/// `update_object` (`PhysicsObj.cs:4140-4190`).
///
/// `false`: the legacy single-step path that consumes the raw,
/// unbounded `dt` in one symplectic-Euler integration. Retained for
/// A/B comparison; flip to `false` to reproduce the pre-2026-06-01
/// "frame-hitch over-integrates a fall" behaviour.
const USE_QUANTUM_SUBDIVIDED_INTEGRATION: bool = true;

/// Physics deep-dive 2026-06-01 (gap 3) — gate for step-up / step-down
/// in the lateral-clamp + floor-snap path of
/// [`MovementSystem::advance_local_pose_for_manual_drive_slice`].
///
/// `true` (default): when a grounded lateral move is blocked by a
/// riser within
/// [`holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT`], raise the
/// player onto it and let the move continue (curb / stair step); and
/// when the player walks off a drop, follow the surface down for drops
/// within [`holtburger_world::spatial::PLAYER_STEP_DOWN_HEIGHT`] instead
/// of falling at the legacy `LEDGE_FALL_THRESHOLD_M = 0.5` heuristic.
/// Mirrors ACE's `Transition.StepUp`/`StepDown` walkable path
/// (`Transition.cs:746-777,852-870`) capped at
/// `ObjectInfo.StepUpHeight`/`StepDownHeight`. The step-DOWN half runs
/// BOTH outdoors (terrain snap) and indoors (per-poly floor snap, F4-1)
/// — retail `Transition.StepDown` is cell-agnostic.
///
/// `false`: the pre-2026-06-01 behaviour — any riser blocks the move
/// (no step-up at all) and a descent beyond `0.5 m` falls. Retained
/// for A/B comparison.
const USE_STEP_UP_DOWN: bool = true;

/// A7-R1 (2026-06-12, survey A7 §3 row 1) — per-setup step heights.
///
/// `true`: the step-up/step-down caps come from the player's hydrated
/// `Setup.step_up/step_down × Scale.Z` values
/// (`world.player.step_up_height`/`step_down_height`, fallback to the
/// hardcoded constants while unhydrated) — retail
/// `CPartArray::GetStepUpHeight`/`GetStepDownHeight`
/// (`acclient.c:325400-325424`; ACE `PartArray.cs:236-248`, cached per
/// transition at `ObjectInfo.cs:46-47` / `acclient.c:314128-314129`).
///
/// `false` (default): the hardcoded human-body
/// [`holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT`] (0.6) /
/// [`holtburger_world::spatial::PLAYER_STEP_DOWN_HEIGHT`] (1.5) stay in
/// effect — byte-identical for the player (its Setup `0x02000001`
/// resolves to exactly those values; the flag only matters for scaled /
/// non-human movers once A6 consumes the entity-side fields).
const USE_SETUP_STEP_HEIGHTS: bool = true;

/// A7-R1 — the effective step-up cap for the local player (see
/// [`USE_SETUP_STEP_HEIGHTS`]).
fn player_step_up_height(world: &WorldState) -> f32 {
    if USE_SETUP_STEP_HEIGHTS && let Some(height) = world.player.step_up_height {
        height
    } else {
        holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT
    }
}

/// A7-R1 — the effective step-down cap for the local player.
fn player_step_down_height(world: &WorldState) -> f32 {
    if USE_SETUP_STEP_HEIGHTS && let Some(height) = world.player.step_down_height {
        height
    } else {
        holtburger_world::spatial::PLAYER_STEP_DOWN_HEIGHT
    }
}

/// A7-R4 (2026-06-12, unification survey) — the restore → precipice-slide
/// re-attempt that consumes the `backup_pose_for_step_down` the A7-era
/// stub only ever saved/cleared. Retail chain: a grounded step whose
/// step-down probe finds no walkable landing reaches
/// `CTransition::edge_slide` (acclient.c:312685), which restores the
/// saved check position (`restore_check_pos`) and — when the mover still
/// tracks a walkable poly and carries the `EDGE_SLIDE` state bit —
/// calls `SPHEREPATH::precipice_slide` (acclient.c:313980):
/// `CPolygon::find_crossed_edge` on the walkable, orient the lip normal
/// against the motion, `slide_sphere` the move along the lip.
///
/// Ours (single-pass solver, OUTDOOR terrain arm only this pass):
/// - walkable poly = the 24 m terrain cell quad under the SLICE-ENTRY
///   position ([`WorldState::terrain_cell_quad_at`]) with the bilinear
///   gradient normal — the per-cell diagonal split is a documented
///   simplification (the quad edges ARE the retail outer edges).
/// - `backup` = the saved post-lateral / pre-descent pose (the retail
///   check position) — its global center is the crossed-edge probe.
/// - the slid move re-probes the SAME step-down decision the original
///   descent used (edge_slide branch (d): `step_down` re-probe then
///   slide, acclient.c:312750-312772); only a walkable `Snap` accepts.
///
/// Returns the accepted landblock-local `(x, y, snap_z)`, or `None` ⇒
/// the caller keeps the existing `begin_fall` path. Gated on the
/// hydrated `PhysicsState::EDGE_SLIDE` bit exactly like retail's
/// `state & 0x200` test (acclient.c:312708).
fn attempt_precipice_slide(
    world: &WorldState,
    backup: &holtburger_common::position::WorldPosition,
    entry_local_xy: (f32, f32),
) -> Option<(f32, f32, f32)> {
    if !world.player.allow_edge_slide {
        return None;
    }
    let global = backup.global_coords();
    // Landblock-local → global XY offset (Z is shared between frames).
    let off_x = global.x - backup.coords.x;
    let off_y = global.y - backup.coords.y;
    let entry_gx = entry_local_xy.0 + off_x;
    let entry_gy = entry_local_xy.1 + off_y;
    // Walkable poly + plane normal under the pre-step (walkable) pose.
    let quad = world.terrain_cell_quad_at(entry_gx, entry_gy)?;
    let plane_n = world.terrain_normal_at(entry_gx, entry_gy)?;
    let up = Vector3::new(0.0, 0.0, 1.0);
    let center = Vector3::new(global.x, global.y, global.z);
    let edge_n = holtburger_world::spatial::find_crossed_edge(&quad, plane_n, center, up)?;
    let motion = Vector3::new(
        backup.coords.x - entry_local_xy.0,
        backup.coords.y - entry_local_xy.1,
        0.0,
    );
    let slid = holtburger_world::spatial::precipice_slide_residual(motion, edge_n)?;
    // Restore to the slice-entry XY and take the along-lip component
    // (lateral-only, consistent with the rest of the legacy chain).
    let new_x = entry_local_xy.0 + slid.x;
    let new_y = entry_local_xy.1 + slid.y;
    let new_gx = new_x + off_x;
    let new_gy = new_y + off_y;
    let z2 = world.terrain_height_at(new_gx, new_gy)?;
    let z2 = if USE_WATER_COLLISION {
        z2 + world.water_depth_at(new_gx, new_gy)
    } else {
        z2
    };
    let outcome = if USE_WALKABLE_STEP_DOWN {
        holtburger_world::spatial::step_down_resolve(
            backup.coords.z,
            z2,
            world.terrain_normal_at(new_gx, new_gy).map(|n| n.z),
            player_step_down_height(world),
            holtburger_world::spatial::FLOOR_Z,
        )
    } else {
        holtburger_world::spatial::step_down_decision(
            backup.coords.z,
            z2,
            player_step_down_height(world),
        )
    };
    match outcome {
        holtburger_world::spatial::StepDownOutcome::Snap(snap_z) => Some((new_x, new_y, snap_z)),
        holtburger_world::spatial::StepDownOutcome::Fall => None,
    }
}

/// A7-R2 (2026-06-12, survey A7 §3 rows 2/3) — walkable step-down.
///
/// `true`: both step-down arms (outdoor terrain + indoor per-poly,
/// F4-1) route through
/// [`holtburger_world::spatial::step_down_resolve`], which adds
/// retail's walkable-landing acceptance — `Transition::StepDown`
/// succeeds only when `contact_plane.N.z >= z_val`
/// (`acclient.c:312664-312669`; ACE `Transition.cs:855-870`) — so a
/// descent onto a steeper-than-[`holtburger_world::spatial::FLOOR_Z`]
/// face FALLS instead of snapping onto it (the downhill complement of
/// F4-2's uphill gate).
///
/// `false` (default): the shipped height-only
/// [`holtburger_world::spatial::step_down_decision`] — byte-identical.
/// 1070-parked: downhill cliff-face feel check.
const USE_WALKABLE_STEP_DOWN: bool = true;

/// A6/A7-R2 (2026-06-12, W5) — `check_walkable` re-insert probe (survey
/// A7 §3 row 3's other half, deferred at W2 until the A6
/// `transitional_insert` seam existed; S7's `spatial/transition.rs` IS
/// that seam, so this gate lives ONLY inside the unified pipeline and
/// is inert unless [`USE_UNIFIED_TRANSITION`]/`?unifiedTransition=on`
/// routes movement through it).
///
/// `true`: retail `CTransition::step_down`'s acceptance arm
/// (`acclient.c:312662-312673`) — an EDGE_SLIDE mover that did NOT
/// begin the slice on walkable support must show positive walkable
/// evidence at a step-down destination (`CTransition::check_walkable`'s
/// re-insert probe, `acclient.c:312475-312524`;
/// `holtburger_world::spatial::physics::check_walkable` +
/// `check_walkable_probe_depth`) or the snap is refused → fall.
///
/// `false` (default): the pipeline's step-down acceptance is unchanged
/// — byte-identical. 1070-parked: steep-face descent feel (rides the
/// `?unifiedTransition` eye-test).
const USE_WALKABLE_REINSERT_PROBE: bool = true;

/// A7-R3 (2026-06-12, survey A7 §3 row 8) — landing walkable allowance.
///
/// `true`: airborne touchdown (outdoor terrain snap + indoor per-poly
/// snap-up) tests the landing surface normal against retail's
/// `z_for_landing = 0.0871557`
/// (`holtburger_world::spatial::collision::physics_globals::LANDING_Z`;
/// `acclient.c:40376`, `:312807-312808`, `:312966-312967`) — landing on
/// faces steeper than walkable is ALLOWED (that's the point of the
/// laxer allowance), but near-vertical perching is refused: the player
/// keeps falling, with the slice's lateral displacement slid
/// Stage-1-style along the refused face's tangent
/// (`slide_residual_along_wall_tangent`).
///
/// `false` (default): touchdown snaps to any surface — byte-identical.
/// 1070-parked: cliff-face jump eye-test.
const USE_LANDING_WALKABLE: bool = true;

/// Physics deep-dive 2026-06-01 (gap 3 follow-up) — gate for the
/// edge_slide tangent-slide in the lateral-clamp + step-up path of
/// [`MovementSystem::advance_local_pose_for_manual_drive_slice`].
///
/// `true` (default): when an indoor lateral move is blocked by a wall
/// AND a step-up onto it is REFUSED (the riser is taller than
/// [`holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT`]), don't stop
/// dead against the wall — slide the blocked residual along the wall
/// tangent (`residual - N·(residual·N)`), gated on the player's
/// hydrated `AllowEdgeSlide` flag
/// ([`holtburger_world::PlayerState::allow_edge_slide`]). Mirrors the
/// retail `Stage-1` single-plane case of `Transition.EdgeSlide` →
/// `SpherePath.StepUpSlide` → `Sphere.SlideSphere`
/// (`Physics/{Transition,SpherePath,Sphere}.cs`), whose
/// no-contact-plane branch removes the into-wall component exactly like
/// the wall clamp's own single-iteration slide.
///
/// `false`: the pre-2026-06-01 behaviour — a refused step-up stops the
/// player dead at the clamped delta. Retained for A/B comparison.
///
/// DEFERRED (needs the CTransition multi-substep loop, NOT in this
/// pass): the Stage-2 retail `cliff_slide` cross-product skid
/// (`N_new × N_last`, `Transition.CliffSlide`
/// `Physics/Transition.cs:242-266`), which slides along the SEAM where
/// two non-coplanar walls meet and requires a SECOND
/// `last_known_contact_plane` tracked across substeps — our
/// single-iteration solver maintains only one. The walkable-edge
/// `precipice_slide` + `step_down` re-entry + `save/restore_check_pos`
/// backup-pose machinery are likewise CTransition substep state we do
/// not have. See the TODO at the edge_slide site below.
const USE_EDGE_SLIDE: bool = true;

/// Physics deep-dive 2026-06-02 (precipice_slide re-entry) — gate for the
/// walkable-edge re-entry backup-pose machinery in the floor-Z step-down
/// snap path of [`advance_local_pose_for_manual_drive_slice`]. Mirrors
/// ACE `Transition.EdgeSlide → StepDown → precipice_slide`
/// (`external/ACE/Source/ACE.Server/Physics/Transition.cs:282-319`) and
/// retail `CTransition::save_check_pos` / `restore_check_pos`
/// (`acclient.c:312499-312501`, `312685-312762`).
///
/// `false` (DEFAULT): the pre-2026-06-02 behaviour — the step-down
/// decision is applied directly with no backup pose maintained, so the
/// shipped solver is byte-identical. `world.player.backup_pose_for_step_down`
/// is never written or read.
///
/// `true`: the pre-descent pose is saved into
/// `world.player.backup_pose_for_step_down` before the step-down
/// walkability check and cleared once the descent resolves (snap / fall /
/// legacy fallback) — AND (A7-R4, 2026-06-12) the restore →
/// precipice-slide re-attempt CONSUMER is live: when the outdoor
/// step-down probe says `Fall`, [`attempt_precipice_slide`] restores the
/// saved pose, finds the crossed edge of the walkable terrain cell
/// (`CPolygon::find_crossed_edge`, acclient.c:360397, ours
/// [`holtburger_world::spatial::find_crossed_edge`]) and skids the
/// blocked move along the cliff lip
/// ([`holtburger_world::spatial::precipice_slide_residual`],
/// `SPHEREPATH::precipice_slide` acclient.c:313980-314040) — an oblique
/// walk-off rides the edge instead of dropping; a perpendicular walk-off
/// sticks at the lip (the retail behavior). The slide only ACCEPTS when
/// its re-probed landing is a walkable `Snap`; otherwise the legacy
/// `begin_fall` runs unchanged. Outdoor terrain arm only this pass
/// (indoor F4-1 step-down keeps the abrupt fall; the unified
/// `transition.rs` pipeline keeps R4 out-of-scope per its module doc).
/// Pending 1070 eye-test (walk off a cliff lip obliquely), BATCHED.
const USE_PRECIPICE_SLIDE_REENTRY: bool = true;

/// Physics deep-dive 2026-06-01 (cliff_slide Stage-2) — gate for the
/// retail SEAM-skid (`Transition.CliffSlide`,
/// `external/ACE/Source/ACE.Server/Physics/Transition.cs:242-266`,
/// `acclient.c:312005`). DEFAULT-OFF: the shipped Stage-1 single-plane
/// edge_slide behaviour is bit-for-bit unchanged until this path is
/// validated on the 1070.
///
/// `false` (DEFAULT): a refused step-up that needs to slide always uses
/// the Stage-1 single-plane [`edge_slide_refused_step_up`] tangent slide
/// (`residual - N·(residual·N)`), exactly the pre-2026-06-02 behaviour.
/// `world.player.last_known_wall_normal` is still MAINTAINED (so flipping
/// this on later sees a valid `N_last`) but is never read.
///
/// `true`: when an indoor refused step-up has BOTH a current wall normal
/// `N_new` (this slice's `cell_wall_normal`) and a previously-tracked
/// `N_last` (`world.player.last_known_wall_normal`, carried across slices
/// by the InitLastKnownContactPlane equivalent below), and the current
/// contact plane is a WALL (`N_new.z < FLOOR_Z`), the residual is skidded
/// along the SEAM where the two non-coplanar walls meet via
/// [`holtburger_world::spatial::cliff_slide_residual_along_seam`]
/// (`Cross(N_new, N_last)` → seam → projected residual). If that helper
/// returns `None` (near-parallel planes ⇒ degenerate seam) OR `N_last`
/// is absent (first wall this run), we fall back to the Stage-1
/// single-plane slide. Outdoor exposes no wall normal, so it stays
/// Stage-1-absent (unchanged) regardless of this flag.
///
/// Gated additionally on [`USE_EDGE_SLIDE`] + the hydrated
/// `AllowEdgeSlide` flag (retail reaches `CliffSlide` only through
/// `EdgeSlide`, which requires the `EdgeSlide` ObjectInfo state —
/// `Transition.cs:270`).
const USE_CLIFF_SLIDE: bool = true;

/// Physics deep-dive 2026-06-01 (gap 4) — gate the AutonomousPosition
/// heartbeat on a position change instead of firing unconditionally.
///
/// `true` (default): the 1 s heartbeat (and the arrival sync) only
/// emit a packet when the pose has meaningfully changed since the last
/// one we sent — cell changed, origin/heading moved beyond
/// [`AUTONOMOUS_POSE_EPSILON_M`]/[`AUTONOMOUS_POSE_HEADING_EPSILON_RAD`],
/// or the contact byte flipped. Mirrors retail
/// `CommandInterpreter::ShouldSendPositionEvent`
/// (`acclient.c:718107-718141`): after the interval elapses it sends on
/// `objcell_id != last || !Frame::is_equal(...)`, and within the
/// interval on a cell or contact-plane change. Stops the heartbeat
/// re-asserting a stale/drifted pose every second.
///
/// `false`: the pre-2026-06-01 behaviour — fire every interval whenever
/// a sync target exists. Retained for A/B comparison.
const USE_AUTONOMOUS_POSITION_CHANGE_GATE: bool = true;

/// Physics deep-dive 2026-06-01 (gap 4) — "meaningfully changed"
/// thresholds for the heartbeat position-change gate. Retail's
/// `Frame::is_equal` is a bit-exact compare; we use small epsilons so
/// integrator round-off (and the per-tick terrain-Z snap) doesn't read
/// as a change and keep the heartbeat alive on a stationary player.
const AUTONOMOUS_POSE_EPSILON_M: f32 = 0.05;
const AUTONOMOUS_POSE_HEADING_EPSILON_RAD: f32 = 0.0035;

/// Track B1 — bounded age after which a server-controlled projection
/// (installed by a MoveToObject during a cast) is abandoned if the
/// server never sent a terminating Stop/Invalid. A MoveToObject install
/// carries no timeout of its own and DRIVES the player toward the target
/// every tick, so a dropped terminating packet would otherwise rubber-
/// band / drag the avatar forever. 8 s comfortably outlasts a normal
/// approach-to-cast while still bounding a stuck projection.
const SERVER_PROJECTION_MAX_AGE: Duration = Duration::from_secs(8);

/// Track B1 — landblock-divergence tolerance for abandoning a
/// server-controlled projection. When the player's landblock no longer
/// matches the projection target's landblock the projection can never
/// converge (the per-frame drive only nudges within the target block),
/// so we CLEAR it rather than drive toward a stale cross-block target.
/// The tolerance is one landblock cell in each axis (the projection
/// install seeds the target into the same cell as the request).
const SERVER_PROJECTION_LANDBLOCK_TOLERANCE: u32 = 1;

/// Physics deep-dive 2026-06-01 (Dimension 3, the contested friction
/// *coefficient*) — A/B knob for the grounded ground-friction value.
///
/// `false` (DEFAULT): keep the gentler hand-tuned
/// [`holtburger_world::movement_common`-side]
/// [`super::common::PLAYER_GROUND_FRICTION_PER_SEC`] (`0.5`). This is the
/// feel-affecting coefficient the wasm integrator has always used; the
/// accel-cap pipeline was tuned around it.
///
/// `true`: use the retail object-level coefficient
/// [`super::common::PLAYER_GROUND_FRICTION_RETAIL`] (`0.95`, ACE
/// `PhysicsGlobals.DefaultFriction`).
///
/// Default-OFF rationale: the Phase-1 grounding for this deep-dive confirmed
/// (high confidence) that retail's friction *compounds* (it does NOT re-set
/// the decayed velocity to the input target each tick) — but it also found
/// that grounded walking never uses that re-set channel, so it did NOT
/// resolve whether `0.95` is correct for *our* architecture (which smooths a
/// stored velocity toward the target with an accel cap and no explicit
/// `Acceleration*quantum` step). The interaction of `0.95` with that cap at
/// steady state is feel-affecting and needs live eyes on the 1070; flipping
/// it on by default would risk a steady-state speed deficit the grounding
/// could not rule out. So: A/B only, default-OFF, awaiting a live capture.
///
/// Independent of this flag, the contact-plane *projection* + SLEDDING
/// overrides (the geometric fidelity in [`super::common::calc_friction`])
/// are always applied to the grounded friction step — they are a no-op on
/// flat ground and only correct behaviour on slopes, so they carry the
/// low-risk fidelity without touching the contested knob.
const USE_RETAIL_GROUND_FRICTION: bool = true;

/// Physics parity 2026-07-03 (F6) — the pre-parity slide-frame friction:
/// `calc_friction(sledding=true)` on contact-but-NOT-grounded frames
/// (the too-steep-plane slide). Retail applies NO friction there —
/// `calc_friction` is gated on `transient_state & 2` (ON_WALKABLE_TS,
/// acclient.h:3691; acclient.c:316108), which a too-steep contact plane
/// never sets — so a fast cliff slide keeps full gravity acceleration
/// (the SLEDDING 0.2-glide table is only reachable by objects that carry
/// SLEDDING_PS *and* stand on a walkable plane). The retail placement is
/// the grounded-frame residual decay in
/// [`MovementSystem::finish_manual_slice_via_transition`]'s landing tail.
///
/// `false` (DEFAULT): retail behavior — no slide-frame friction.
/// `true`: the documented deviation (a damped "controlled" cliff slide),
/// kept compiled for A/B.
const USE_SLIDE_FRAME_FRICTION: bool = false;

/// Physics parity 2026-07-03 (F1/F2) — the retail `update_object` slice
/// loop (acclient.c:323123-323161; MIN/MAX at :784229/:784235):
///   - entry `dt <= 0.0002` (f32 bits of retail's 0.00019999999):
///     time CONSUMED, nothing integrated;
///   - `dt > 2.0` (HugeQuantum): consumed, nothing integrated;
///   - `dt <= 0.2` (retail MAX_QUANTUM = 1/5): integrated DIRECTLY as ONE
///     quantum — there is NO 1/30 floor on the direct path (`goto
///     LABEL_21`), so a 60 fps client steps physics 16.7 ms EVERY frame;
///   - else: 0.2-sized slices while remaining > 0.2, then the remainder
///     is integrated iff > 1/30 (MIN_QUANTUM) else CARRIED to the next
///     frame (retail advances `update_time` only by the consumed slices).
///
/// `false` (DEFAULT): the shipped ACE-shaped loops stay byte-identical —
/// handle path accumulates-to-1/30 with 0.1 slices ([`quantum_slices`]),
/// spine path passes any remainder > 0.0 (client/simulation.rs). The
/// DECISIONS-A1-O5 ruling (0.1 slices to dodge ACE's documented
/// MoveToManager-turning bug at 0.2) stands until explicitly reopened;
/// flipping this default needs that ruling revisited plus a move_to.rs
/// turn-deadband regression check at 0.2 s slices.
/// `true`: both the handle path
/// ([`MovementSystem::advance_local_pose_for_manual_drive`]) and the
/// spine path take the retail shape above via
/// [`MovementSystem::retail_quantum_schedule`].
const USE_RETAIL_QUANTUM: bool = false;

/// Unified movement pipeline STAGE 1 (2026-06-11) — interpreted-state
/// velocity derivation + retail direct-set grounded velocity model.
/// Design: `apps/holtburger-web/docs/2026-06-11-unified-movement-pipeline/DESIGN.md`
/// (§2 THE VELOCITY CONTRACT, §3 Stage 1). ABSORBS AND RETIRES the
/// 2026-06-09 `USE_DIRECT_GROUND_VELOCITY` (F1-1) gate: its ON path
/// ("direct-set grounded planar velocity to the interpreted-state
/// target") IS this pipeline's grounded behaviour — it must not survive
/// as a second competing speed source.
///
/// `false` (DEFAULT): the legacy path, byte-identical pre-stage-1
/// behaviour — `target_velocity` comes from `local_velocity_for_state`
/// (`common.rs:686-734`) and each grounded slice friction-decays the
/// stored planar velocity ([`super::common::PLAYER_GROUND_FRICTION_PER_SEC`]
/// `0.5`) then moves it toward the target clamped to
/// [`super::common::PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ`] (`8.0`)
/// per axis. That interaction has a closed-form steady-state ceiling
/// `v* = 8·q/(1−0.5^q) ≈ 11.7 m/s` (q∈[1/30,0.1]), so any run target above
/// ~11.7 (run_rate > ~2.92, effective Run skill ≳ 460) is UNREACHABLE — the
/// player tops out ~20–35 % below retail's 18 m/s max run, with a 1.5–4 s
/// ice-skating ramp and a ~5 m stop-skid (the F1-1 finding). Kept for A/B.
///
/// `true`: the retail-shaped ONE pipeline — `target_velocity` is derived
/// through the `CMotionInterp` port
/// ([`super::motion_interp::interpreted_velocity_for_state`]):
/// input → `RawMotionState` → `apply_raw_movement` (3× `adjust_motion` +
/// `apply_run_to_command`, `acclient.c:343746-343803`/`:343439-343483`)
/// → `InterpretedMotionState`, ground velocity = AUTHORED MotionData
/// cycle base speed (run 4.000 / walk 2.602) × interpreted speed_mod
/// (already run-rate-multiplied) per `add_motion`
/// (`acclient.c:337431-337474`) + `CSequence::apply_physics`
/// (`acclient.c:339860-339890`); and the grounded planar velocity is set
/// DIRECTLY to that target each slice (retail self-powered locomotion
/// never fights `calc_friction` — `MotionInterp.cs:506-523,678-699`).
/// No accel-cap ramp, no skid; the small-velocity snap still stops
/// instantly on release. Same speed_mod will drive the rig in stage 2 —
/// the anti-ice-skating contract (`acclient.c:337465`). DEFAULT-OFF
/// pending the 1070 gait eye-test (DESIGN.md §3 stage-1 eye-test plan:
/// integrator speed == 4.0×run_rate, raw ACE UpdatePosition deltas
/// agree, zero force-position sequence advances / no snapback); on PASS
/// integrate always-on + mark DONE in url-flags.md per the passed-flag
/// policy.
const USE_INTERPRETED_VELOCITY: bool = true;

/// A4-Q1 (2026-06-11 unification survey) — STAGE 2 completion layer,
/// the retail `MotionTableManager` pending-animation queue
/// ([`super::motion_table_manager`]). Specced ONCE in
/// `docs/2026-06-11-unified-movement-pipeline/DESIGN.md`
/// "STAGE 2 AMENDMENT" (A3-D1 fold).
///
/// `true`: the tick pumps the queue's per-frame completion poll —
/// retail `MotionTableManager::UseTime` tailcalls
/// `CheckForCompletedMotions` (BN pseudo-C
/// `acclient_2013.bndb_pseudo_c.txt:290845-290850`; body
/// `acclient.c:329960`; ACE `MotionTableManager.cs:158-161`), reached
/// per-frame via `CPhysicsObj::update_object_internal` →
/// `CPartArray::HandleMovement` (`acclient.c:322882` →
/// `:325106-325112`).
///
/// `false` (DEFAULT): the pump is skipped and — since nothing enqueues
/// until the A3-D2 `PerformMovement`/`motion_done` consumer and the
/// A4-Q2 renderer `AnimationDone` wiring (`?mtQueue=` +
/// `notifyAnimationDone` export) land — the queue is fully inert;
/// current one-shot paths are untouched. Flip plan (DESIGN.md
/// amendment): A3-D2 → A4-Q2 → 1070 eye-test (spam-click truncation,
/// emote-completes-then-gait-resumes), then default-on per the
/// passed-flag policy.
const USE_MOTION_TABLE_QUEUE: bool = true;

/// A3-D3-5 (2026-06-12, unified movement pipeline STAGE 3) —
/// non-charged leave-ground velocity.
///
/// `true`: at a walk-off-ledge airborne transition (`begin_fall`), stamp
/// `current_planar_velocity` from the CLAMPED retail closed form —
/// `CMotionInterp::get_leave_ground_velocity` = `get_state_velocity`
/// (magnitude capped at `run_rate × 4.0`) with the retail fallback to
/// the integrator's velocity when the closed form is ~zero
/// (acclient.c:343806-343843, consumed by `LeaveGround`
/// :344457-344490; ACE `MotionInterp.cs:192`). Fixes survey A3 §3 row 6
/// DIFF-ALGO: the legacy freeze launched the UNCLAMPED diagonal
/// run+strafe composition (~5.7 m/s vs retail's 4.0×rate cap).
///
/// `false` (DEFAULT): the legacy trajectory-lock freeze — the planar
/// store is left untouched at launch, byte-identical. Charged-jump
/// departures (interpreted intent via `manual_intent_velocity`, the
/// wasm Jump arm) are unchanged either way (DESIGN.md:487-488).
/// HitGround stays event-less per the recorded decision
/// (DESIGN.md:476-479 — the per-tick re-derive subsumes it).
/// 1070-parked: walk off a ledge at diagonal run+strafe — measured
/// launch speed ≤ run_rate×4.0; jump arcs + arms-up pose UNCHANGED.
const USE_LEAVE_GROUND_VELOCITY: bool = true;

/// A6-T1/T2 (2026-06-12, W3+ spec S7) — the retail transition-pipeline
/// rewrite of the local-player tick spine. ONE feature, TWO carriers:
/// this const (native default) and the `?unifiedTransition=on` URL flag
/// (wasm; parsed in `apps/holtburger-web/src/lib.rs` →
/// `MovementSystemHandle::set_unified_transition` →
/// [`MovementSystem::unified_transition_runtime`]). Effective predicate
/// at every consumption site:
/// [`MovementSystem::unified_transition_enabled`].
///
/// `true` / flag-on: BOTH local-player solver arms route through retail's
/// single pipeline (`CPhysicsObj::transition` →
/// `find_transitional_position`, acclient.c:320061/313171 — ported as
/// [`holtburger_world::spatial::transition`]):
///   - T1: the legacy handle path
///     ([`MovementSystem::advance_local_pose_for_manual_drive_slice`])
///     swaps its single-pass clamp chain for the substep pipeline
///     ([`MovementSystem::advance_manual_slice_via_transition`]).
///   - T2: the canonical tick spine's simulation solve
///     (`client/simulation.rs`) resolves the local player through the
///     SAME pipeline instead of the collision-free
///     `advance_grounded_body_kinematics` arm — killing the W1-created
///     P2b hole where `?unifiedTick=on` manual movement walked through
///     everything, and upgrading the drive arm from buildings-only to
///     the full chain. `?unifiedTick=on&unifiedTransition=on` is the
///     first browser configuration that is simultaneously
///     canonical-spine AND fully-collided.
///
/// `false` (DEFAULT): every legacy path is untouched code —
/// byte-identical, rollback is dropping the URL flag.
///
/// Intended behavioral deltas under the flag (why promotion is
/// 1070-eye-test-gated, W6): anti-tunneling substeps, always-available
/// seam skid, per-step cell transit. Needs wasm rebuild; NO manifest
/// bump (no new JS-visible export).
const USE_UNIFIED_TRANSITION: bool = true;

/// Phase 3 B4 (2026-06-28) — route the local player's collision through the
/// decomp-faithful `CTransition` driver (holtburger-dat
/// `transition::driver_validate`, bridged by
/// `holtburger_world::spatial::faithful_bridge`) instead of the existing
/// transition pipeline. ONE feature, TWO carriers: this const (native default)
/// and a runtime carrier ([`MovementSystem::faithful_transition_runtime`], the
/// Phase-B `?faithfulTransition=on` URL flag). Effective predicate:
/// [`MovementSystem::faithful_transition_enabled`].
///
/// `true` (DEFAULT, Phase E 2026-06-28): the dispatcher
/// ([`holtburger_world::spatial::transition::find_transitional_position_dispatch`])
/// routes to the faithful driver — env-cells faithful, in-cell STATICS faithful
/// (Phase C: `SceneObjCell::find_obj_collisions` over `cell_static_physics_bsp`),
/// outdoor via the existing heightfield. Flipped default-on after validation:
/// holtburger-dat `transition::` (252 pass) + the `mod drift` static-stop test,
/// the in-world static-BSP live feed (cells drain real static BSPs), and the
/// in-world A/B (faithful on/off both in-world, grounded, 0 errors). Mirrors the
/// `USE_UNIFIED_TRANSITION = true` convention above. Rollback: revert this const.
///
/// `false` / flag-off: the dispatcher routes to the unchanged existing pipeline
/// (byte-identical). The Phase-B runtime carrier
/// ([`MovementSystem::faithful_transition_runtime`], `?faithfulTransition=on`)
/// remains for forcing the faithful path on when this const is `false`.
const USE_FAITHFUL_TRANSITION: bool = true;

/// Phase 3 Phase D (2026-06-28) — extend the faithful `CTransition` driver to
/// OUTDOOR terrain (land-cell triangle polygons + buildings/statics + entities)
/// instead of delegating outdoor poses to the approximate heightfield pipeline.
/// Read ONLY when the faithful path is already active
/// ([`MovementSystem::faithful_transition_enabled`]); it gates the OUTDOOR
/// branch INSIDE
/// [`holtburger_world::spatial::faithful_bridge::faithful_find_transitional_position`]
/// (WS3/WS4) — the indoor env-cell path is unaffected.
///
/// ONE feature, TWO carriers (mirrors [`USE_FAITHFUL_TRANSITION`]): this const
/// (native default) + a runtime carrier
/// ([`MovementSystem::faithful_outdoor_runtime`], the `?faithfulOutdoor=off` URL
/// flag). Effective predicate: [`MovementSystem::faithful_outdoor_enabled`],
/// threaded as the `faithful_outdoor` dispatch arg (WS4).
///
/// `true` (DEFAULT, Phase D): an outdoor pose floods the sphere-radius land-cell
/// ring (`add_all_outside_cells_sphere`) and collides against each cell's 2
/// terrain triangles → buildings/statics BSP → entities, mirroring decomp
/// `CLandCell::find_collisions` (acclient.c:354887).
///
/// `false` / `?faithfulOutdoor=off`: outdoor poses delegate to the existing
/// heightfield pipeline (the Phase A/B/C behavior), byte-identical. The escape
/// for the Phase D A/B rollback.
const USE_FAITHFUL_OUTDOOR: bool = true;

/// Phase 3 Phase E1 / WS-D (2026-06-29) — faithful walkable STEP-UP / slope &
/// ledge climbing. When on, a grounded CONTACT mover that walks into a walkable
/// up-slope / ramp / stair / ledge CLIMBS it (the decomp `CSphere::step_sphere_up`
/// → `CTransition::step_up` path, gated by `step_up_height < radsum + EPSILON −
/// disp.z`) instead of stopping at the base. Read ONLY when the faithful path is
/// already active ([`MovementSystem::faithful_transition_enabled`]); the climb
/// only exists inside the faithful `CTransition` driver. The WS-B (indoor BSP)
/// and WS-C (outdoor terrain) climb seams read it via the
/// `CTransition::faithful_stepup` carrier threaded through the dispatch.
///
/// ONE feature, TWO carriers (mirrors [`USE_FAITHFUL_OUTDOOR`]): this const
/// (native default) + a runtime carrier
/// ([`MovementSystem::faithful_stepup_runtime`], the `?stepUp=off` URL flag).
/// Effective predicate: [`MovementSystem::faithful_stepup_enabled`], threaded as
/// the `faithful_stepup` dispatch arg.
///
/// `true` (DEFAULT, Phase E1): climb walkable up-slopes/ledges.
///
/// `false` / `?stepUp=off`: the pre-E1 behavior — a grounded mover stops at the
/// base of a walkable up-slope (the climb-on vs stop-at-base A/B rollback).
const USE_FAITHFUL_STEPUP: bool = true;

/// FU-3 (2026-07-20) — dynamic-object (entity) collision arm for the LIVE
/// faithful `CTransition` driver. The faithful branch of
/// [`holtburger_world::spatial::transition::find_transitional_position_dispatch`]
/// collides ONLY the cell env-BSP + baked cell statics; dynamic entities
/// (doors, monsters, players) NEVER block the local player there — a parity
/// gap versus retail, where `CObjCell::find_obj_collisions` sweeps resident
/// dynamic objects too. When on, the live faithful slice
/// ([`Self::finish_manual_slice_via_transition`]) clamps the REALIZED lateral
/// residual against collidable entity cylinders
/// ([`holtburger_world::spatial::clamp_delta_against_entities`]) AFTER the
/// dispatch resolves terrain/env/static geometry + grounding.
///
/// Ethereal exemption is free: the gather honors
/// [`holtburger_world::entity::Entity::is_collidable`] (false for
/// `ETHEREAL | IGNORE_COLLISIONS`, retail acclient.c ~316196-316299), so an
/// OPEN (ethereal) door is exempt and a CLOSED (collidable) door blocks. The
/// `IGNORE_CREATURES` object-state gate is honored too (mirrors
/// `GeometryCaches::gather`).
///
/// ONE feature, TWO carriers (mirrors [`USE_UNIFIED_TRANSITION`]): this const
/// (native default) + a runtime carrier
/// ([`MovementSystem::faithful_entity_collision_runtime`]). Effective
/// predicate: [`MovementSystem::faithful_entity_collision_enabled`]. The clamp
/// is read ONLY when [`Self::faithful_transition_enabled`] is also on (it fills
/// the faithful driver's gap; the non-faithful pipeline already clamps entities
/// per-step inside `insert_check_offset`).
///
/// `false` (DEFAULT): the live faithful path is unchanged — entities do not
/// block (the pinned parity gap). `true`: entities block laterally.
///
/// The clamp touches the XY residual ONLY: the vertical grounding /
/// contact-plane / `frames_stationary_fall` state derived from the transition
/// `outcome` is left untouched, so a blocked entity cannot corrupt grounding.
const USE_FAITHFUL_ENTITY_COLLISION: bool = false;

/// (2026-06-30) — extend the faithful driver's persistent `ON_WALKABLE`
/// grounded-latch to OUTDOOR poses standing on a resident static/building
/// surface (e.g. a building ROOF), so jumping onto a roof STAYS instead of
/// sliding off + reverting to the jump origin. The roof is collided by the same
/// static-BSP narrow-phase as indoor floors (building physics BSP staged into
/// `cell_static_physics_bsp` by the 0x01/0x02 building-BSP bake), but the
/// pre-existing `ON_WALKABLE` entry stamp fired `is_indoors()`-only
/// (`faithful_bridge.rs`), so an outdoor roof was collided as a wall yet never
/// grounded. ONE feature, TWO carriers (mirrors [`USE_FAITHFUL_STEPUP`]): this
/// const (native default) + the `?roofGrounding=off` URL flag
/// ([`MovementSystem::outdoor_static_grounding_runtime`]). Effective predicate:
/// [`MovementSystem::outdoor_static_grounding_enabled`], baked into
/// `TransitionGates::outdoor_static_grounding`. The read site additionally gates
/// on a resident static BSP in the begin cell so the pure-terrain heightfield
/// cliff-stop is unaffected.
///
/// `true` (DEFAULT): outdoor static/building roofs are walkable + grounded.
/// `false` / `?roofGrounding=off`: the pre-2026-06-30 indoor-only latch.
const USE_OUTDOOR_STATIC_GROUNDING: bool = true;

/// (2026-07-02) — retail outdoor GROUND MOVEMENT in the faithful driver:
/// enables OBJECTINFO `step_down` (retail `OBJECTINFO::init`,
/// acclient.c:314131 — always true for a non-missile mover), stamps the
/// persistent CONTACT|ON_WALKABLE grounded latch for OUTDOOR terrain
/// (retail `get_object_info`, acclient.c:319074-319099), and seeds/carries
/// the mover's stored contact plane across slices (`init_contact_plane` /
/// `init_last_known_contact_plane`, acclient.c:315599/315612 →
/// `world.player.last_contact_plane`). Together these arm the already-
/// ported retail chain the live path never reached: the step-down snap
/// (feet planted downhill, acclient.c:312961-313009 + walk_interp bound
/// :314259-314280), the FLOOR_Z slope refusal (steep contact → `step_down`
/// rejects at `N.z < 0.664`, :312666), `edge_slide` → `cliff_slide`
/// (slide down/along a too-steep face, :312685-312791) and the lip
/// block/slide (Collided step re-pinned via last-known plane,
/// `validate_transition` branch A). Jump keeps its retail bypass: an
/// airborne entry stamps NEITHER bit, so edge protection does not apply
/// mid-air (retail `CMotionInterp::jump` → `set_on_walkable(0)`,
/// acclient.c:344247).
///
/// ONE feature, TWO carriers (mirrors [`USE_OUTDOOR_STATIC_GROUNDING`]):
/// this const (native default) + the `?retailGround=off` URL flag
/// ([`MovementSystem::retail_ground_runtime`]). Effective predicate:
/// [`MovementSystem::retail_ground_enabled`], baked into
/// `TransitionGates::retail_ground`.
///
/// `true` (DEFAULT): retail ground movement — cliffs refuse/slide, downhill
/// sticks, lips block/slide, jump clears them.
/// `false` / `?retailGround=off`: the pre-2026-07-02 behavior (climbable
/// cliffs, airborne-flicker downhill, emergent edge behavior).
const USE_RETAIL_GROUND: bool = true;

/// (2026-07-02, mechanism replaced 2026-07-03) — retail MOVEMENT-AUTONOMY
/// arbitration (the cast-movement feel: slidecast / fastcast / "fighting
/// the cast"). The engine is retail's `last_move_was_autonomous` LATCH,
/// not a timed gesture window:
///
/// - The latch is LOWERED from the WIRE: `SmartBox::SetObjectMovement`
///   (acclient.c:311185-311193) stamps it with the message's autonomous
///   flag before unpacking — and for the LOCAL player only accepted
///   NON-autonomous messages reach the unpack (autonomous echoes skip
///   both), so the wire only ever lowers it. ACE plays cast windups /
///   gestures / MoveTo directives as non-autonomous `UpdateMotion`.
/// - The latch is RAISED by every fresh local motion command — retail
///   `CPhysicsObj::DoMotion` (:317325) / `StopMotion` (:317364) — i.e.
///   any manual-input EDGE (press OR release; identical re-sends are not
///   edges, matching the edge-driven `CommandInterpreter` stacks
///   :717102/:717429 where a held key never re-fires) and a successful
///   jump release (`ClientCombatSystem::DoJump` autonomous branch
///   :408146; `LeaveGround` re-applies movement, :344457).
/// - The per-slice drive dispatches on it — retail
///   `CMotionInterp::apply_current_movement` (:344305):
///   `latch ? apply_raw_movement : apply_interpreted_movement`. While
///   LOW, the INTERPRETED (server-echo) state drives: the gesture
///   occupies the single forward slot (`RawMotionState::ApplyMotion`
///   default arm :332890, interpreted mirror :332759) at zero
///   locomotion, so forward dies; sidestep/turn are INDEPENDENT slots
///   (:344147 drives each separately) and keep flowing — slidecast.
///   Held keys stop driving until the next edge — fastcast's
///   tap-to-break and the "fight to move forward" metronome.
///
/// NO hard root is added — the server's fizzle circle (ACE
/// `Windup_MaxMove`) stays server-side.
///
/// ONE feature, TWO carriers: this const (native default) + the
/// `?castMove=off` URL flag ([`MovementSystem::cast_move_runtime`]).
/// Effective predicate: [`MovementSystem::cast_move_enabled`].
///
/// `true` (DEFAULT): the latch governs the drive dispatch per retail.
/// `false` / `?castMove=off`: raw input always drives (pre-2026-07-02).
const USE_CAST_MOVE: bool = true;

/// (2026-07-03, mage-PvP strafecast) — HELD sidestep/turn survive the
/// local player's non-autonomous GENERAL motion stomps (the slidecast
/// strafe dance vs vanilla ACE).
///
/// ACE broadcasts every cast gesture back to the CASTER as a
/// non-autonomous General `UpdateMotion` whose sidestep/turn axes are
/// EMPTY — NPK: one full stomp per windup (`EnqueueMotionMagic`,
/// `WorldObject_Networking.cs:1078-1093`, ignores `persist_movement`);
/// PK/FastTick: one stomp at windup start (`EnqueueMotionAction`
/// :1231-1273, forward=Ready + gestures as actions) plus the cast
/// gesture (`EnqueueMotion` castGesture arm) and the FinishCast return.
/// Each stomp reaches `move_to_interpreted_state` and zeroes the
/// interpreted sidestep/turn, so a HELD strafe dies at every echo and
/// the retail strafecast ("locked into strafing, dancing left-right
/// while the cast plays") is impossible — the community's "slidecasting
/// is completely fixable that ACE refuses to". Retail servers never
/// re-stomped the caster mid-cast: the gesture animation was
/// client-authored (the "invisible animation break" — a local cut the
/// server can't detect — only works if the server isn't re-asserting
/// the gesture), so held sidestep/turn simply kept flowing.
///
/// ON: after a General (case-0) stomp for the LOCAL player, the
/// currently-held manual sidestep/turn are re-applied onto the
/// interpreted axes — EXACTLY the axis set ACE's own opt-in
/// `Motion.Persist` carries (`Entity/Motion.cs:162-166`, the
/// `persist_movement` server dial, default false and NOT wired into the
/// magic path — `PropertyManager.cs:575`). Forward is NEVER re-applied:
/// the gesture owns the single forward slot and held-W stays dead until
/// a fresh forward EDGE ([`USE_CAST_MOVE`]'s core, retail :332759).
///
/// ONE feature, TWO carriers: this const (native default) + the
/// `?slideCast` URL flag ([`MovementSystem::slide_cast_runtime`]).
/// Effective predicate: [`MovementSystem::slide_cast_enabled`].
///
/// ADJ-8 (2026-07-04) — DEFAULT FLIPPED to `false` (the authentic
/// burst) per the user's ruling, verbatim: "slideCast=off feels more
/// authentic however there are some catches". Landed only after bug A
/// (the leash echo gate) was confirmed dead on the 1070 — the work
/// order's ordering constraint.
///
/// `false` (DEFAULT): the bare stomp (strafe dies per echo,
/// tap-to-revive only — the authentic vanilla-ACE burst feel).
/// `true` / `?slideCast=on`: held strafe/turn ride through
/// cast-gesture stomps (the modern opt-in).
const USE_SLIDE_CAST: bool = false;

/// (2026-07-12, WS04 S3a) — `?castHoldReclaim`: while a KNOWN local cast
/// chain is in flight, the FU-A `use_time` reclaim keeps the FORWARD slot
/// dead across the WHOLE chain instead of reviving held-W per-windup-node.
///
/// The leak: for a TARGETED cast the server's turn-to-target
/// (`Player_Magic.cs` `Rotate`/`TurnTo_Magic`) sets `local_server_controlled`,
/// so FU-A is LIVE; each windup node holds `player_motions_pending` for its
/// authored length then drops it, and the very next `use_time` pump reclaims
/// control WITHOUT a fresh edge and re-drives the held forward substate head
/// (`command_interpreter.rs::apply_current_movement`) — held-W revives in the
/// gap before the next windup stomp re-lowers the latch. Multi-windup ⇒
/// multiple revive windows ⇒ net forward travel.
///
/// Strafe/turn still reclaim (slidecast untouched — orthogonal to
/// [`USE_SLIDE_CAST`]); a jump clears the lock (retail `LeaveGround`
/// re-applies held movement, acclient.c:344457/:344484); a fresh FORWARD
/// edge is untouched (fastcast anim-break preserved — the edge path never
/// arms the lock, only the edgeless `use_time` reclaim is gated). Signal
/// source: the JS chain stamps `SessionHandle::noteLocalCastWindow(active)`.
///
/// ONE feature, TWO carriers: this const (native default) + the
/// `?castHoldReclaim=on` URL flag ([`MovementSystem::cast_hold_reclaim_runtime`]).
/// Effective predicate: [`MovementSystem::cast_hold_reclaim_enabled`].
///
/// `false` (DEFAULT): today's per-windup forward revival (regression floor).
/// `true` / `?castHoldReclaim=on`: hold the forward slot dead across the
/// whole cast chain. Default OFF — eye-test gated (the leak is
/// targeted-cast-only, FU-A-dormant for self buffs).
const USE_CAST_HOLD_RECLAIM: bool = false;

/// Movement-port WAVE 1 step 4 (2026-07-03) — the retail
/// `CommandInterpreter` INPUT LANE master gate (the strangler flag).
///
/// OFF (DEFAULT): the existing input lane (`setMovementInput` →
/// `ManualSet` → castMove/slideCast) runs byte-identical — the
/// live-validated strafecast behavior is the regression floor
/// (docs/HANDOFF-physics-parity-mage-pvp-2026-07-03.md session 2).
/// ON (`?cmdInterp=on`): key edges arrive as input-action ids →
/// [`QueuedDriveCommand::KeyEdge`] → the unified
/// [`super::command_interpreter::CommandInterpreter`] (per-axis
/// CommandLists, head-wins pop-through, FU-A TakeControl full re-apply,
/// FU-C silent releases — all INSIDE the interpreter; `?cmdInterp` IS
/// their gate, no separate flags).
///
/// Ownership handover while ON (the conflict contract —
/// docs/PLAN-cmdinterp-wave1-landing-2026-07-03.md, rows 1-14): exactly
/// ONE writer per state row; both lanes must never drive in the same
/// tick (debug-asserted in [`MovementSystem::tick`]).
///
/// DEFAULT FLIPPED ON 2026-07-03 (step-5 A/B green: all three local
/// protocol arms + the 1070 eye test — user ruling: "its decent").
/// `?cmdInterp=off` is the escape hatch back to the legacy lane; the
/// legacy carriers stay intact until the post-flip cleanup wave.
const USE_COMMAND_INTERPRETER: bool = true;

/// Phase 3 Phase D (2026-06-28, Option C) — register each outdoor
/// building/static BSP into EVERY land cell its world AABB overlaps, not just
/// its home cell, so an off-center building can no longer be walked through from
/// a neighbor cell. Index-only deviation from retail: the swept-sphere driver +
/// `find_obj_collisions` stay byte-faithful — only the per-cell static index
/// (`holtburger_world::spatial::scene` `cell_static_physics_bsp`) is widened.
/// Read by the bake (WS7 `scene.rs` / WS8 `apps/holtburger-web/src/lib.rs`) via
/// [`MovementSystem::building_overlap_enabled`].
///
/// ONE feature, TWO carriers (mirrors [`USE_FAITHFUL_TRANSITION`]): this const
/// (native default) + a runtime carrier
/// ([`MovementSystem::building_overlap_runtime`], the `?buildingOverlap=off` URL
/// flag). Effective predicate: [`MovementSystem::building_overlap_enabled`].
///
/// `true` (DEFAULT, Phase D): full overlap registration — the off-center fix.
///
/// `false` / `?buildingOverlap=off`: register each static/building into its HOME
/// cell only = the exact retail home-cell-only behavior = the off-center
/// walk-through bug repro. This is the OFF arm of the drift A/B proof (off-center
/// building: overlap-on STOPS the mover, overlap-off WALKS THROUGH).
const USE_BUILDING_OVERLAP: bool = true;

/// F4-2 (bughunt 2026-06-09) — outdoor walkable-slope gate.
///
/// `false` (DEFAULT): the legacy behaviour — outdoor grounded movement
/// snaps Z onto the bilinear terrain height for ANY rise with no slope test
/// (the `FLOOR_Z` walkable classifier was wired only into the INDOOR cell
/// triangle path), so a player can run straight up an arbitrarily steep
/// cliff/mountain face at full speed. The lateral clamp never blocks bare
/// terrain either, so nothing stops the climb. Retained as the default until
/// the gate is eye-tested on the 1070.
///
/// `true`: refuse to walk onto a terrain plane steeper than retail's
/// `FloorZ` (`holtburger_world::spatial::FLOOR_Z` = `0.664174`, ~48.4° from
/// horizontal — ACE `PhysicsGlobals.FloorZ`, `LandCell.FindEnvCollisions` →
/// `ObjectInfo.is_valid_walkable`). When a grounded outdoor step is UPHILL
/// (terrain Z above the feet) onto a face whose surface normal
/// ([`holtburger_world::WorldState::terrain_normal_at`]) has `z < FLOOR_Z`,
/// block the advance: revert the lateral move to the slice-entry XY (stop at
/// the cliff base) and skip the up-snap, so the player can't gain height onto
/// the cliff. Walking ALONG the base (destination terrain still walkable) is
/// unaffected. DEFERRED follow-ons (refinements, not the exploit): sliding
/// the residual along the slope contour instead of a hard stop (reuse
/// `edge_slide`), the retail slide-DOWN when already standing on a
/// non-walkable plane, feeding the terrain normal into `calc_friction` for
/// uphill slowdown, and the exact per-cell triangle SPLIT normal (the gate
/// uses the bilinear-gradient normal, faithful at the walkable cutoff).
const USE_TERRAIN_WALKABLE_GATE: bool = true;

/// F4-4 (bughunt 2026-06-09) — deep-water movement block.
///
/// `false` (DEFAULT): the legacy behaviour — outdoor movement snaps Z to the
/// raw heightmap (the LAKEBED height for water cells) and never reads terrain
/// type, so a player runs straight across lake/ocean floors under the rendered
/// water plane; the world boundaries retail enforces with water (island
/// separation, moats) are absent. Retained as default until eye-tested.
///
/// `true`: refuse to walk a grounded step INTO a fully-water 24 m cell
/// ([`holtburger_world::WorldState::is_entirely_water_cell_at`] — all four
/// corner vertices water-typed), mirroring ACE `LandCell.FindEnvCollisions`
/// (`EntirelyWater && !IsViewer && !IsMissile => TransitionState.Collided`).
/// The advance is reverted to the slice-entry XY (stop at the shoreline), the
/// same mechanism as the [`USE_TERRAIN_WALKABLE_GATE`] cliff refusal. DEFERRED
/// (documented follow-on): the partially-water wading-depth contact-plane raise
/// (`ObjectInfo.ValidateWalkable` `+ waterDepth`) — this pass only hard-blocks
/// EntirelyWater cells. Needs a wasm rebuild + 1070 eye-test. Caveat to watch
/// in eye-test: only the GROUNDED step is gated (a jump arc over water is the
/// airborne branch, unblocked — correct), but a grounded player on an elevated
/// over-water static (a bridge) would also be refused; such bridges over
/// EntirelyWater are rare in AC outdoor terrain (water = open ocean/lake) and
/// the outdoor solver already snaps grounded Z to the lakebed there.
const USE_WATER_COLLISION: bool = true;

/// FU-1 (eye-test 2026-06-11) — exclude wielded/parented child objects
/// from the player-vs-entity collision pass.
///
/// Retail removes a child from the world the moment it is parented:
/// `CPhysicsObj::set_parent` → `unset_parent` + `leave_world`
/// (`acclient.c:322965`), so a wielded weapon is never a collision
/// candidate. ACE mirrors this (`PhysicsObj.set_parent` →
/// `leave_world()`, `PhysicsObj.cs:3827`) and additionally
/// short-circuits collision for any `Parent != null` object
/// (`PhysicsObj.cs:2187`). Wielded weenies carry neither `ETHEREAL`
/// nor `IGNORE_COLLISIONS`, so `is_collidable()` alone admits them;
/// our entities keep their `world.entities` membership after a
/// ParentEvent (`handlers/inventory.rs` sets `physics_parent_id`),
/// leaving a just-equipped weapon as a collider centred on the player
/// — which zeroes the lateral delta and pins the player in place.
/// `true`: skip any entity with `physics_parent_id` set, mirroring the
/// retail `Parent != null` exclusion.
const SKIP_PARENTED_ENTITY_COLLISION: bool = true;

/// 2026-06-02 indoor floor-pop fix — gate the ramped/multi-level
/// floor-Z resolution in the `else` arm of
/// [`MovementSystem::advance_local_pose_for_manual_drive_slice`].
///
/// `true` (default): split the floor-Z snap into two sources. The
/// up-snap fires only on a *real* per-poly triangle floor
/// ([`holtburger_world::spatial::highest_floor_z_under`]); the cell
/// AABB's `min.z` is demoted to a last-resort *lower bound* that only
/// catches a player whose retained Z has dropped below the whole cell
/// (true fall-through). On a ramp/stair cell where
/// `highest_floor_z_under` returns `None` (XY in a tread seam, sparse
/// poly set, or an unbaked segment), the retained Z is preserved
/// instead of being yanked down to the cell minimum. Symmetric with the
/// friction contact-plane projection, which already treats "no per-poly
/// floor under me" (`floor_normal_under == None`) as "keep what I have"
/// via the `(0,0,1)` no-op fallback.
///
/// `false`: the pre-2026-06-02 behaviour — `highest_floor_z_under(...)
/// .or_else(|| aabb.min.z)` feeds a single combined `floor_z` into the
/// unconditional `pose.coords.z < floor + 0.005` up-snap, popping the
/// player to the cell's lowest floor whenever the per-poly query misses.
/// Retained for A/B comparison.
const USE_RAMP_FLOOR_SNAP_FIX: bool = true;

/// BSP collision PASS 1 (2026-06-02, DATA LA) — gate the faithful
/// physics-BSP narrow-phase blocking test in the indoor lateral-clamp
/// path of
/// [`MovementSystem::advance_local_pose_for_manual_drive_slice`].
/// DEFAULT-OFF so the shipped flat-triangle-bag solver
/// ([`holtburger_world::spatial::clamp_delta_against_cell_walls_dispatch`])
/// is the unchanged default; this is the opt-in `?bspCollide=on` path
/// for later 1070 validation.
///
/// `false` (DEFAULT): the indoor clamp is exactly the pre-2026-06-02
/// behaviour — per-poly flat-triangle wall clamp + cell-AABB
/// containment net. The physics BSP is parsed + plumbed into
/// `SpatialScene.cell_physics_bsp` regardless, but never consulted, so
/// flipping this on is a pure runtime switch with no re-bake.
///
/// `true`: AFTER the flat-tri clamp computes its `lateral_clamped`
/// (which already carries the slide/back-off the integrator needs as
/// the fallback), probe the AUTHORITATIVE physics BSP. Lower the player
/// capsule to ACE's two collision spheres (`NumSphere == 2`: low at
/// `feet + radius`, high at `head − radius`) at the FULLY-REQUESTED
/// (un-clamped) end pose and run the faithful
/// `BSPNode.sphere_intersects_solid` walk
/// (`external/ACE/Source/ACE.Server/Physics/BSP/BSPNode.cs:265-293` +
/// `BSPLeaf.cs:80-91`). If the BSP says the requested target is NOT
/// solid, take the full requested lateral move (the flat-tri bag was
/// over-clamping a passable opening); if it IS solid, keep the flat-tri
/// `lateral_clamped` slide result (the working solver's back-off /
/// slide stays the resolution mechanism — PASS 1 does not reimplement
/// the retail `Transition` slide/step state machine, see the DEFERRED
/// notes below). When the cell has no parsed BSP the probe no-ops and
/// the flat-tri result stands.
///
/// DEFERRED (NOT in this pass — needs the multi-pass Transition
/// stack): a faithful `BSPTree.find_collisions` that resolves the
/// final pose THROUGH the BSP (StepUp / SlideSphere / CollideObject
/// orchestration) rather than using the BSP only as a solid gate over
/// the flat-tri slide. See the module-doc DEFERRED block.
const USE_PHYSICS_BSP: bool = true;

/// B4 Tier-2 (2026-06-09): per-static physics-BSP push-out for OUTDOOR
/// statics. SEPARATE from `USE_PHYSICS_BSP` (indoor cells) on purpose —
/// the indoor-BSP authority question is unresolved, and entangling the two
/// gates would block this. When OFF (DEFAULT) the static-collision path is
/// exactly the shipped Tier-1 coarse-AABB stop/slide; the per-static BSPs
/// are parsed + plumbed into `SpatialScene.statics_physics_bsp` regardless
/// but never consulted, so flipping this on is a pure runtime switch with
/// no re-bake. When ON: statics carrying a precise BSP are CEDED from the
/// coarse-AABB sweep (whose 8-corner bound stops the capsule short of thin
/// geometry like a tree trunk) to `resolve_static_bsp_pushout`, which runs
/// ACE `BSPTree.placement_insert` to push the capsule out of the true
/// solid. Push-out only: it resolves penetration each tick (fine at
/// walking speed, where the per-tick step is far smaller than a trunk
/// radius); the swept time-of-collision stop (`BSPTree.find_collisions`
/// + the Transition step/slide stack) that would stop a FAST move AT the
/// surface is the deferred Tier-2 follow-on, as is per-part BSP for 0x02
/// SetupModel statics. See the static-sweep block below.
const USE_STATIC_BSP: bool = true;

/// Terrain→EnvCell entry (2026-06-02): when ON (DEFAULT), the manual-
/// drive integrator flips the local player indoors the tick its capsule
/// enters a loaded EnvCell, instead of waiting for the server's
/// authoritative cell id — mirroring retail's client-local
/// `check_building_transit` (acclient.c:348110). Fixes walking through
/// cottage / dungeon shells from outdoors: cottages are EnvCells with no
/// outdoor building AABB, so the outdoor branch had nothing to clamp
/// against, and indoor collision is gated on `is_indoors()` (which keyed
/// off the server-stamped cell id). The membership data (`cell_bsp`) is
/// plumbed into `scene.cell_membership` regardless, so this is a pure
/// runtime gate. Kill-switch: set `false` to restore the pre-2026-06-02
/// server-only transition.
const USE_LOCAL_ENVCELL_ENTRY: bool = true;

/// 2026-06-02 outdoor building-wall edge/cliff-slide (Phase 6 follow-on):
/// gate for enabling edge-slide / cliff-slide on outdoor building AABB
/// walls, not just indoor cell polygon walls. When OFF (DEFAULT) the
/// outdoor building clamp returns no wall normal and both stages stay
/// indoor-only, preserving the shipped solver's byte-identical behaviour.
/// When ON, the outdoor sweep's AABB face normal is captured into
/// `cell_wall_normal` (then `last_known_wall_normal`) so the refused
/// step-up slide and seam-skid fire outdoors too. See
/// `clamp_delta_against_buildings_with_normal`.
const USE_OUTDOOR_WALL_NORMALS: bool = true;

/// Physics deep-dive 2026-06-01 (gap 1) — bound + subdivide a raw
/// per-frame `dt` (seconds) into the integration-slice schedule,
/// mirroring ACE's `update_object` timestep gate
/// (`external/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:4140-4190`).
///
/// Returns:
/// - `None` when `dt > HUGE_QUANTUM` — the whole frame is dropped (no
///   integration), so a multi-second hitch can't teleport a falling
///   player. (`PhysicsObj.cs:4169-4173`.)
/// - `Some(slices)` otherwise — a list of slice durations, each
///   `<= MAX_QUANTUM`, summing to (almost) `dt`: the frame is split
///   into `MAX_QUANTUM` slices with the sub-`MAX_QUANTUM` remainder
///   appended only when it exceeds `MIN_QUANTUM` (ACE floors the
///   remainder at 1/30 s and drops anything smaller —
///   `PhysicsObj.cs:4175-4186`). A frame shorter than `MIN_QUANTUM`
///   yields an empty schedule (nothing integrated this frame),
///   matching retail's 30 Hz physics gate.
///
/// Single source of truth for both the production loop in
/// [`MovementSystem::advance_local_pose_for_manual_drive`] and the
/// subdivision-count unit tests.
fn quantum_slices(dt_secs: f32) -> Option<Vec<f32>> {
    if dt_secs > HUGE_QUANTUM {
        return None;
    }
    let mut slices = Vec::new();
    let mut remaining = dt_secs;
    while remaining > MAX_QUANTUM {
        slices.push(MAX_QUANTUM);
        remaining -= MAX_QUANTUM;
    }
    if remaining > MIN_QUANTUM {
        slices.push(remaining);
    }
    Some(slices)
}

/// F1/F2 (physics parity 2026-07-03) — the RETAIL `update_object` slice
/// schedule (acclient.c:323123-323161; constants :784229/:784235), the
/// [`USE_RETAIL_QUANTUM`] shape. Returns `(slices, carry)`:
/// - `dt <= 0.0002` ([`PHYSICS_ENTRY_EPSILON`]): `(vec![], 0.0)` — time
///   CONSUMED, nothing integrated (:323123);
/// - `dt > 2.0` ([`HUGE_QUANTUM`]): `(vec![], 0.0)` — consumed, dropped
///   (:323127/:323145);
/// - `dt <= 0.2` ([`RETAIL_MAX_QUANTUM`]): `(vec![dt], 0.0)` — integrated
///   DIRECTLY as ONE quantum, no 1/30 floor on the direct path
///   (:323127 `goto LABEL_21`);
/// - else: 0.2 slices while remaining > 0.2, then the remainder is a
///   final slice iff > 1/30 ([`MIN_QUANTUM`]) else returned as `carry`
///   for the caller to bank (retail advances `update_time` only by the
///   consumed slices — :323146-323148).
///
/// `carry > 0.0` implies `slices` is non-empty (only the post-slicing
/// remainder banks), so a carrying caller can never starve.
fn retail_quantum_schedule(dt_secs: f32) -> (Vec<f32>, f32) {
    if dt_secs <= PHYSICS_ENTRY_EPSILON {
        return (Vec::new(), 0.0);
    }
    if dt_secs > HUGE_QUANTUM {
        return (Vec::new(), 0.0);
    }
    if dt_secs <= RETAIL_MAX_QUANTUM {
        return (vec![dt_secs], 0.0);
    }
    let mut slices = Vec::new();
    let mut remaining = dt_secs;
    while remaining > RETAIL_MAX_QUANTUM {
        slices.push(RETAIL_MAX_QUANTUM);
        remaining -= RETAIL_MAX_QUANTUM;
    }
    if remaining > MIN_QUANTUM {
        slices.push(remaining);
        (slices, 0.0)
    } else {
        (slices, remaining)
    }
}

/// Physics deep-dive 2026-06-01 (gap 3 follow-up: edge_slide Stage-1).
/// Resolve the lateral delta to apply when a grounded step-up was
/// REFUSED (the riser blocking the move was taller than the step-up
/// height).
///
/// - `lateral`: the full requested lateral move (un-clamped).
/// - `lateral_clamped`: the wall-clamped lateral move (what we'd apply
///   if we just stopped dead against the wall).
/// - `wall_normal`: the XY contact-plane normal surfaced by the wall
///   clamp (`None` when the clamp had no hit — e.g. the move was
///   blocked by entity collision or the AABB safety net, neither of
///   which exposes a wall normal yet).
/// - `allow_edge_slide`: the player's hydrated `AllowEdgeSlide` flag.
///
/// When [`USE_EDGE_SLIDE`] is on, `allow_edge_slide` is set, and a wall
/// normal is available, the blocked residual (`lateral -
/// lateral_clamped`) is projected onto the wall tangent and added back
/// to the clamped delta so the player skids along the wall instead of
/// stopping dead. Mirrors retail `SpherePath.StepUpSlide` →
/// `Sphere.SlideSphere` no-contact-plane branch (removes the into-wall
/// component). Otherwise returns `lateral_clamped` unchanged (retail's
/// "no EdgeSlide flag ⇒ just stop").
///
/// Cliff_slide Stage-2 (`USE_CLIFF_SLIDE`, DEFAULT-OFF): before the
/// Stage-1 single-plane slide, attempt the retail SEAM-skid when this
/// slice's wall (`wall_normal` = `N_new`) is a genuine WALL
/// (`N_new.z < FLOOR_Z`) AND a previously-tracked wall
/// (`last_known_wall_normal` = `N_last`) exists. The seam
/// [`holtburger_world::spatial::cliff_slide_residual_along_seam`]
/// (`Cross(N_new, N_last)`) redistributes the residual along the line
/// where the two non-coplanar walls meet — riding a concave corner
/// instead of stopping at the first wall. A degenerate seam
/// (near-parallel planes ⇒ `None`) or an absent `N_last` (first wall
/// this run) falls straight through to the Stage-1 single-plane slide,
/// so the Stage-2 path is a strict superset that only engages in the
/// two-wall wedge case. Mirrors retail `Transition.EdgeSlide` →
/// `CliffSlide` (`Transition.cs:276-279`).
fn edge_slide_refused_step_up(
    lateral: Vector3,
    lateral_clamped: Vector3,
    wall_normal: Option<Vector3>,
    last_known_wall_normal: Option<Vector3>,
    allow_edge_slide: bool,
) -> Vector3 {
    if !USE_EDGE_SLIDE || !allow_edge_slide {
        return lateral_clamped;
    }
    let Some(normal) = wall_normal else {
        return lateral_clamped;
    };
    // Residual = the portion of the requested move the wall clamp
    // removed.
    let residual = lateral - lateral_clamped;

    // Cliff_slide Stage-2 (opt-in): when a second non-coplanar wall is
    // tracked and this slice's contact plane is a WALL (not a steep
    // floor), skid the residual along the seam the two walls form. This
    // is the retail two-plane case; it shadows the Stage-1 single-plane
    // slide below and falls back to it on a degenerate/absent seam.
    if USE_CLIFF_SLIDE {
        if let Some(n_last) = last_known_wall_normal {
            // Retail's `EdgeSlide` only reaches `CliffSlide` when the
            // contact plane is a WALL (`ContactPlane.Normal.Z < zval`);
            // a steep-but-walkable floor takes the precipice/step-down
            // branch instead, which we do NOT implement here.
            let is_wall = normal.z < holtburger_world::spatial::FLOOR_Z;
            if is_wall {
                if let Some(seam_slide) = holtburger_world::spatial::cliff_slide_residual_along_seam(
                    residual, normal, n_last,
                ) {
                    return lateral_clamped + seam_slide;
                }
                // `None` ⇒ near-parallel planes (degenerate seam):
                // fall through to the Stage-1 single-plane slide.
            }
        }
    }

    // Stage-1: slide the residual along the wall tangent (drop the
    // into-wall component) and add it onto the clamped delta.
    let slide = holtburger_world::spatial::slide_residual_along_wall_tangent(residual, normal);
    lateral_clamped + slide
}

/// G-6 / F4-2 follow-on (2026-06-11) — slide-along-contour for a REFUSED
/// uphill terrain step (the [`USE_TERRAIN_WALKABLE_GATE`] cliff refusal).
/// Retail doesn't stop dead at a too-steep face: the un-walkable contact
/// plane sheds the into-slope component and the walker skids along the
/// contour line (the same `Sphere.SlideSphere` tangent projection the
/// indoor edge_slide reuses). The contour "wall" is the face normal
/// projected to XY and normalized — the horizontal direction pointing
/// away from the slope; sliding the lateral move against it leaves
/// exactly the along-contour component.
///
/// Returns `None` when there is nothing useful to slide: a face with no
/// XY lean (degenerate for a refused face — `n.z < FLOOR_Z` implies a
/// strong XY component, but guard anyway) or a head-on approach whose
/// tangent component is negligible (the hard stop is then correct).
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
    let slide = holtburger_world::spatial::slide_residual_along_wall_tangent(lateral, contour_wall);
    if slide.x * slide.x + slide.y * slide.y < 1e-10 {
        return None;
    }
    Some(slide)
}

#[derive(Debug, Default)]
struct MovementSequenceDiagnostics {
    last_force_position_sequence: Option<u16>,
    last_teleport_sequence: Option<u16>,
    last_server_control_sequence: Option<u16>,
}

impl MovementSequenceDiagnostics {
    fn record_force_position_sequence(&mut self, force_position_sequence: u16) {
        if let Some(old_seq) = self.last_force_position_sequence {
            if is_newer_u16(force_position_sequence, old_seq) {
                log::warn!(
                    "Server forced reposition (rubber band): force seq {} -> {}",
                    old_seq,
                    force_position_sequence
                );
            } else if force_position_sequence != old_seq {
                log::debug!(
                    "Ignoring stale forced reposition: force seq {} after {}",
                    force_position_sequence,
                    old_seq
                );
            }
        }

        self.last_force_position_sequence = Some(force_position_sequence);
    }

    fn record_autonomous_position_sequences(
        &mut self,
        teleport_sequence: u16,
        force_position_sequence: u16,
        server_control_sequence: u16,
    ) {
        match self.last_teleport_sequence {
            Some(old_seq) if is_newer_u16(teleport_sequence, old_seq) => {
                log::info!(
                    "Server-forced resync teleport epoch advanced: teleport seq {} -> {} (force seq {}, server-control seq {})",
                    old_seq,
                    teleport_sequence,
                    force_position_sequence,
                    server_control_sequence
                );
            }
            Some(old_seq) if teleport_sequence != old_seq => {
                log::debug!(
                    "Ignoring stale server-forced resync: teleport seq {} after {} (force seq {}, server-control seq {})",
                    teleport_sequence,
                    old_seq,
                    force_position_sequence,
                    server_control_sequence
                );
            }
            None => {
                log::info!(
                    "Tracking teleport sequence {} for autonomous resync (force seq {}, server-control seq {})",
                    teleport_sequence,
                    force_position_sequence,
                    server_control_sequence
                );
            }
            _ => {}
        }

        self.last_teleport_sequence = Some(teleport_sequence);
        self.last_force_position_sequence = Some(force_position_sequence);
        self.last_server_control_sequence = Some(server_control_sequence);
    }

    fn record_server_control_sequence(&mut self, server_control_sequence: u16) {
        match self.last_server_control_sequence {
            Some(old_seq) if is_newer_u16(server_control_sequence, old_seq) => {
                log::debug!(
                    "Server-controlled motion epoch advanced: {} -> {}",
                    old_seq,
                    server_control_sequence
                );
            }
            Some(old_seq) if server_control_sequence != old_seq => {
                log::warn!(
                    "Server-controlled motion reordered/stale: {} after {}",
                    server_control_sequence,
                    old_seq
                );
            }
            None => {
                log::debug!(
                    "Tracking server-controlled motion sequence: {}",
                    server_control_sequence
                );
            }
            _ => {}
        }

        self.last_server_control_sequence = Some(server_control_sequence);
    }
}

/// A3-D3-5 helper — stamp the retail leave-ground launch velocity into
/// the planar store at a walk-off-ledge `begin_fall` transition (all
/// three ledge sites: outdoor step-down Fall, legacy ledge heuristic,
/// indoor F4-1 step-down Fall). No-op unless
/// [`USE_LEAVE_GROUND_VELOCITY`]; the legacy default keeps the
/// trajectory-lock freeze byte-identical. Charged jumps never route
/// through here (`begin_jump` is the wasm Jump arm). Z stays owned by
/// the gravity arc.
fn stamp_leave_ground_velocity(
    world: &mut WorldState,
    heading: f32,
    state: MotionState,
    capabilities: &holtburger_world::SelfMovementCapabilities,
) {
    if !USE_LEAVE_GROUND_VELOCITY {
        return;
    }
    let mut velocity = leave_ground_velocity_for_state(
        heading,
        state,
        capabilities,
        world.player.current_planar_velocity,
    );
    velocity.z = 0.0;
    world.player.current_planar_velocity = velocity;
}

pub(crate) struct MovementSystem {
    sequence_diagnostics: MovementSequenceDiagnostics,
    queued_drive_commands: Vec<QueuedDriveCommand>,
    pending_transient_motion: Option<TransientMotionIntent>,
    pending_arrival_pose: Option<holtburger_common::position::WorldPosition>,
    pending_snap_facing: Option<f32>,
    active_drive: Option<ActiveDriveState>,
    server_motion_active: bool,
    last_server_motion_intent: Option<ServerMotionIntent>,
    suppress_frontend_autonomous_once: bool,
    server_controlled_projection: Option<ServerControlledProjection>,
    /// Track B1 — install time of the active server-controlled
    /// projection, used by [`reconcile_server_controlled_projection`] to
    /// abandon a projection that the server never closes out (no explicit
    /// Stop/Invalid arm arrived) after [`SERVER_PROJECTION_MAX_AGE`]. A
    /// MoveToObject installs no timeout of its own, so a dropped
    /// terminating packet would otherwise drive the player toward the
    /// target forever. `None` whenever no projection is installed.
    server_controlled_projection_installed_at: Option<Instant>,
    next_autonomous_position_heartbeat_at: Option<Instant>,
    /// Physics deep-dive 2026-06-01 (gap 4) — the pose + contact byte of
    /// the last AutonomousPosition packet we actually sent, used by the
    /// position-change gate (retail `last_sent_position` /
    /// `last_sent_contact_plane`). `None` until the first send.
    last_sent_autonomous_pose: Option<holtburger_common::position::WorldPosition>,
    last_sent_autonomous_contact: Option<u8>,
    /// Phase 4 step 3.6 diagnostic — incremented every time the
    /// autonomous-position heartbeat or arrival sync fires. The wasm
    /// bundle reads this via [`MovementSystemHandle::heartbeats_sent`]
    /// to verify the heartbeat actually emits packets (server-side
    /// position updates are async + flushed lazily, so client-side
    /// observability is essential for debugging).
    pub(crate) heartbeats_sent: u32,
    /// A4-Q1 (2026-06-11) — the local player's retail
    /// `MotionTableManager` pending-animation queue
    /// (`acclient.h:31097-31104`; per-entity instances arrive with
    /// DESIGN.md Stage 3). Pumped per-tick under
    /// [`USE_MOTION_TABLE_QUEUE`] (default-off → inert).
    motion_table_manager: MotionTableManager,
    /// A3-D2 (2026-06-12) — the local player's `CMotionInterp`
    /// completion consumer: the pump routes the manager's `MotionDone`
    /// events into [`MotionInterp::motion_done`]
    /// (`acclient.c:317097` → `:339349` → `:343641-343676`). Same
    /// default-off gate; per-entity instances arrive with Stage 3.
    local_motion_interp: MotionInterp,
    /// A3-D3 (2026-06-12) — the per-entity `MovementManager` registry
    /// (retail: one `MovementManager` per `CPhysicsObj`; DESIGN.md
    /// STAGE 3 AMENDMENT "per-entity `my_run_rate`, no globals" — the
    /// F3-5 rule). Local player keyed by the player guid (its events
    /// arrive via `SelfServerControlledMotion`). Populated only under
    /// [`USE_UNPACK_MOVEMENT_SEMANTICS`]; pruned on
    /// `WorldEvent::EntityDespawned` in
    /// [`Self::apply_movement_world_events`] (growth bounded by entity
    /// count between prunes).
    movement_managers: HashMap<Guid, MovementManager>,
    /// A6-T1/T2 — runtime carrier of the `?unifiedTransition=on` URL
    /// flag (wasm recv-loop init calls
    /// `MovementSystemHandle::set_unified_transition`). OR'd with the
    /// [`USE_UNIFIED_TRANSITION`] const by
    /// [`Self::unified_transition_enabled`]. Default `false`.
    unified_transition_runtime: bool,
    /// Phase 3 B4 (2026-06-28) — runtime carrier of the Phase-B
    /// `?faithfulTransition=on` URL flag. OR'd with the
    /// [`USE_FAITHFUL_TRANSITION`] const by
    /// [`Self::faithful_transition_enabled`]. Default `false`.
    faithful_transition_runtime: bool,
    /// FU-3 (2026-07-20) — runtime carrier of the faithful-driver
    /// entity-collision arm. OR'd with the [`USE_FAITHFUL_ENTITY_COLLISION`]
    /// const by [`Self::faithful_entity_collision_enabled`]. Default `false`.
    faithful_entity_collision_runtime: bool,
    /// Phase 3 Phase D (2026-06-28) — runtime carrier of the
    /// `?faithfulOutdoor=off` URL flag. `None` = use the
    /// [`USE_FAITHFUL_OUTDOOR`] const default (ON); `Some(false)` forces the
    /// outdoor heightfield fallback (the A/B rollback escape); `Some(true)`
    /// forces it on. Combined by [`Self::faithful_outdoor_enabled`]. Default
    /// `None`.
    faithful_outdoor_runtime: Option<bool>,
    /// Phase 3 Phase E1 / WS-D (2026-06-29) — runtime carrier of the
    /// `?stepUp=off` URL flag. `None` = use the [`USE_FAITHFUL_STEPUP`] const
    /// default (ON); `Some(false)` forces the pre-E1 stop-at-base behavior
    /// (the climb A/B rollback escape); `Some(true)` forces it on. Combined by
    /// [`Self::faithful_stepup_enabled`]. Default `None`.
    faithful_stepup_runtime: Option<bool>,
    /// (2026-06-30) — runtime carrier of the `?roofGrounding=off` URL flag.
    /// `None` = use the [`USE_OUTDOOR_STATIC_GROUNDING`] const default (ON);
    /// `Some(false)` forces the pre-2026-06-30 indoor-only grounded latch (the
    /// roof-grounding A/B rollback); `Some(true)` forces it on. Combined by
    /// [`Self::outdoor_static_grounding_enabled`]. Default `None`.
    outdoor_static_grounding_runtime: Option<bool>,
    /// Phase 3 Phase D (2026-06-28, Option C) — runtime carrier of the
    /// `?buildingOverlap=off` URL flag. `None` = use the
    /// [`USE_BUILDING_OVERLAP`] const default (ON); `Some(false)` forces
    /// home-cell-only registration (the retail-bug repro arm of the drift A/B).
    /// Combined by [`Self::building_overlap_enabled`]. Default `None`.
    building_overlap_runtime: Option<bool>,
    /// (2026-07-02) — runtime carrier of the `?retailGround=off` URL flag.
    /// `None` = the [`USE_RETAIL_GROUND`] const default (ON); `Some(false)`
    /// rolls the retail outdoor ground-movement port back (the A/B escape).
    /// Combined by [`Self::retail_ground_enabled`]. Default `None`.
    retail_ground_runtime: Option<bool>,
    /// (2026-07-02) — runtime carrier of the `?castMove=off` URL flag.
    /// `None` = the [`USE_CAST_MOVE`] const default (ON); `Some(false)`
    /// disables the cast-gesture movement arbitration. Combined by
    /// [`Self::cast_move_enabled`]. Default `None`.
    cast_move_runtime: Option<bool>,

    /// (2026-07-12, WS04) — runtime carrier of the `?castHoldReclaim=on` URL
    /// flag. `None` = the [`USE_CAST_HOLD_RECLAIM`] const default (OFF);
    /// `Some(true)` holds the forward slot dead across a whole cast chain.
    /// Combined by [`Self::cast_hold_reclaim_enabled`]. Default `None`.
    cast_hold_reclaim_runtime: Option<bool>,
    /// WS04 — set by the JS cast chain via [`Self::note_local_cast_window`];
    /// `true` from windup start to chain completion/fizzle/cancel. Read by
    /// the interpreter seam [`SystemInterpreterSeams::local_cast_forward_lock_active`].
    local_cast_window_active: bool,

    /// `?slideCast=off` runtime carrier ([`USE_SLIDE_CAST`]) —
    /// [`Self::slide_cast_enabled`]. Default `None`.
    slide_cast_runtime: Option<bool>,
    /// `?cmdInterp=on` runtime carrier ([`USE_COMMAND_INTERPRETER`]) —
    /// [`Self::cmd_interp_enabled`]. Default `None` (OFF).
    cmd_interp_runtime: Option<bool>,
    /// Wave-1 step 4 — the unified retail input interpreter (dark lane).
    /// Lazily constructed at the first [`QueuedDriveCommand::KeyEdge`]
    /// (which only exists under `?cmdInterp=on`); `Option` so the
    /// interpreter can be moved OUT during dispatch while the seam
    /// borrows the rest of the system (the SC-15 borrow split).
    command_interpreter: Option<super::command_interpreter::CommandInterpreter>,
    /// Wave-1 step 5 (row 9) — MoveToState pulses queued by the
    /// interpreter seam's `send_move_to_state` (the seam is sync,
    /// `Session::send_action` is async — the same queue-then-flush
    /// pattern the pulse sends use). Each entry is the composed drive
    /// at seam-call time; the tick flushes them in order through the
    /// M1 converter and stamps `note_server_motion_sent`, which is
    /// exactly what keeps the tick's own edge-detector silent for
    /// key-driven edges (one sender per edge, zero new suppression
    /// state).
    pending_cmd_interp_sends: Vec<MotionState>,
    /// Diagnostics/test counter — MoveToState motion pulses actually
    /// sent (the legacy edge-detector site AND the step-5 interpreter
    /// flush). The row-9 one-sender-per-edge contract is pinned on it.
    pub(crate) motion_state_pulses_sent: u32,
    /// Wave-1 step 5 (row 8) — a jump release queued by the interpreter
    /// seam's `do_jump(autonomous)` for the tick's async flush
    /// (`execute_jump_release` sends the Jump pack; seams are sync).
    pending_cmd_interp_jump_release: bool,
    /// Wave-1 step 5 (rows 12-13) — the interpreter-lane event stream
    /// for JS consumers: interpreter effects (forward-slot eviction,
    /// FU-A reclaims) + the installed drive per dispatched edge + jump
    /// refusals. Drained by [`Self::take_cmd_interp_events`] from the
    /// wasm TickMovement arm each tick; only interp-lane sites push, so
    /// flag-off (and the native cli) never accumulates.
    cmd_interp_events: Vec<CmdInterpEvent>,
    /// Physics-parity 2026-07-03 (dossier A F1/F2) — runtime carrier of
    /// the `?retailQuantum=on` URL flag. `None` = the
    /// [`USE_RETAIL_QUANTUM`] const default (OFF — the DECISIONS-A1-O5
    /// ruling stands); `Some(true)` runs the retail update_object slice
    /// schedule. Combined by [`Self::retail_quantum_enabled`]. Default
    /// `None`.
    retail_quantum_runtime: Option<bool>,
    /// Retail `CPhysicsObj::last_move_was_autonomous` — THE movement
    /// autonomy latch (see [`USE_CAST_MOVE`] for the full mechanism).
    /// LOWERED from the wire autonomous flag at the
    /// `SelfServerControlledMotion` consumption site
    /// ([`Self::note_server_authored_motion`], retail
    /// acclient.c:311185-311193); RAISED by every manual-input edge
    /// ([`Self::ingest_drive_command`], retail :317325/:317364) and a
    /// successful jump release. Read by
    /// [`Self::interpreted_movement_active`]. `false` at boot = the
    /// retail ctor (:319552); the first input edge raises it.
    last_move_was_autonomous: bool,
    /// FU5 (row 64) — set alongside every latch-raising local command
    /// edge; the next drive pump consumes it as retail
    /// `TakeControlFromServer` (acclient.c:716934-716953) when the
    /// scene's `local_server_controlled` flag is up.
    pending_take_control: bool,
    /// A14-I4 (W3+ S11, 2026-06-12) — the retail jump charge clock
    /// (`ClientCombatSystem` `jump_pending` / `buildStartTime`,
    /// acclient.c:407902-407916). Reached only via the wasm
    /// `?jumpParity=on` bridge (`jump_charge_commence` /
    /// `execute_jump_release` / `jump_charge_abort`); the legacy
    /// JS-clock path never touches it.
    jump_charge: JumpChargeClock,
    /// A2-P3 (2026-06-12, W3+ S9) — deferred `cancel_moveto` signal:
    /// the per-slice sticky step lives in the `&self` pose tails, so a
    /// sticky TIMEOUT is reported through this `Cell`; the next
    /// `tick()` (`&mut self`) consumes it and clears the
    /// server-controlled projection (ACE `StickyManager.ClearTarget →
    /// cancel_moveto`, StickyManager.cs:38-40). One-tick deferral,
    /// bounded; only ever set under
    /// [`holtburger_world::spatial::USE_STICKY_MANAGER`].
    sticky_timeout_pending: std::cell::Cell<bool>,
    /// A3-D3 driver (M4.5) — manual-cancel parity flag: a NON-IDLE
    /// `ManualSet` ingested this tick owes the local MoveTo driver a
    /// `CancelMoveTo(0x36)` (retail raw input cancels MoveTo:
    /// `CMotionInterp::apply_raw_movement` →
    /// `CPhysicsObj::cancel_moveto` →
    /// `MovementManager::CancelMoveTo(0x36)`, acclient.c:317421-317427
    /// → :339240-339246). Set in [`Self::ingest_drive_command`] (no
    /// world/guid access there), consumed by the
    /// [`USE_MOVETO_DRIVER`] shim. Inert without an active directive.
    manual_moveto_cancel_pending: bool,
    /// A14-I2 (W3+ S10, `?wasmPursuit=on`) — the last `ManualSet`
    /// motion state ingested, recorded UNGATED (pure bookkeeping, zero
    /// behavior change without pursuit intents). Restored as the
    /// active manual drive when a pursuit ends — the charge-end
    /// WASD-stomp fix: retail keeps manual movement and MoveTo on
    /// separate manager-arbitrated channels
    /// (`MoveToManager::PerformMovement` acclient.c:346123 /
    /// `MovementManager::CancelMoveTo` on raw input acclient.c:339240),
    /// so a held W survives a MoveTo's end; our legacy JS fake-WASD
    /// path zeroed it instead.
    last_manual_drive: Option<MotionState>,
    /// A14-I2 — pursuit entry commands queued by
    /// [`Self::ingest_drive_command`] (no world access there) and
    /// applied by [`Self::apply_pending_pursuit_commands`] inside
    /// `tick` (which has the world + the `MovementManager` registry).
    /// Order-preserving within a tick.
    pending_pursuit_commands: Vec<PendingPursuitCommand>,
    /// A14-I2 — true while a LOCAL pursuit installed through the S10
    /// input lane is steering. Used by the `ManualSet` ingest arm so
    /// an IDLE manual set (all keys released) is recorded but does NOT
    /// stomp the steering drive (retail: releasing keys does not abort
    /// a MoveTo — it runs until `CleanUpAndCallWeenie`,
    /// acclient.c:345171). Cleared on every pursuit end path.
    local_pursuit_engaged: bool,
    /// (2026-07-20) — the LOCAL MoveTo driver's stall-recovery state
    /// machine (see `stall_recovery.rs`). BOT-ONLY, not a retail port:
    /// when the autonomous Walk steer realizes near-zero displacement for
    /// several consecutive ticks (the indoor "wedge" — retail-faithful
    /// `slide_sphere` Blocked on an exactly-orthogonal input), this
    /// perturbs the steered heading off-bearing so the mover can shear off
    /// the blocking plane, mirroring how a live player escapes by
    /// jittering input. Manual WASD input never reaches this — only
    /// [`Self::drive_local_moveto`]'s `Walk` arm calls
    /// [`MoveToStallRecovery::poll`].
    moveto_stall: MoveToStallRecovery,
    /// A14-I3 (2026-06-12, `?retailRunKeys=on`) — the retail
    /// `CommandInterpreter::auto_run` state (acclient.h:35349; ctor
    /// zero-init acclient.c:717753). While set, the effective manual
    /// drive is forward+Run regardless of the held forward/backstep
    /// keys — retail `ApplyCurrentMovement` issues forward at
    /// `autorun_speed` with `hold_run=1` BEFORE ever consulting the
    /// SubstateList (acclient.c:717027-717064), and `NukeCommand`
    /// refuses to pop substate heads while `auto_run`
    /// (acclient.c:717472). Sidestep/turn lists still apply. Set ONLY
    /// via [`Self::set_auto_run`] (the wasm `setAutoRun` bridge, which
    /// JS calls only under the default-off URL flag) — default `false`
    /// = byte-identical legacy behavior. `autorun_speed` is not
    /// carried: retail defaults it to 1.0 (acclient.c:717756) and only
    /// the speed-argument command form (cmd 0x09000047 + float)
    /// changes it, which we don't surface.
    auto_run: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum QueuedDriveCommand {
    ManualSet(MotionState),
    ManualPulse {
        state: MotionState,
        duration: Duration,
    },
    /// Wave-1 step 4 (`?cmdInterp=on` ONLY) — one raw input-action edge
    /// for the retail interpreter lane (ADJ-4: JS forwards INPUT-ACTION
    /// ids 0x29-0x32, resolved to motion commands wasm-side by
    /// `on_action`; the P14 keymap bugs are fixed by construction).
    /// `down` = press vs release. The legacy `ManualSet` lane never
    /// carries keyboard edges while the flag is on (ownership row 4).
    KeyEdge { action: u32, down: bool },
    Autonomous(AutonomousDriveIntent),
    Transient(TransientMotionIntent),
    ArriveAtPose {
        pose: holtburger_common::position::WorldPosition,
    },
    SnapFacing {
        heading: f32,
    },
    Stop,
    /// A14-I2 mirror of [`PlayerDriveIntent::PursueObject`].
    Pursue {
        target: Guid,
        object_radius: f32,
        object_height: f32,
        run: bool,
    },
    /// A14-I2 mirror of [`PlayerDriveIntent::TurnToObject`].
    PursuitTurnToObject { target: Guid },
    /// A14-I2 mirror of [`PlayerDriveIntent::TurnToHeading`]
    /// (`heading` still RADIANS here; degrees conversion at apply).
    PursuitTurnToHeading { heading: f32 },
    /// A14-I2 mirror of [`PlayerDriveIntent::CancelPursuit`].
    CancelPursuit,
    /// rynth Phase-1 mirror of [`PlayerDriveIntent::MoveToPosition`].
    MoveToPosition {
        cell_id: Guid,
        position: holtburger_common::math::Vector3,
        run: bool,
    },
}

/// Wave-1 step 5 (PLAN rows 12-13) — the `?cmdInterp=on` lane's
/// JS-facing event stream: what the renderer must react to now that the
/// legacy sig-diff side-effects (W3.1 forward clip, anim-break cut,
/// `setSidestepLayer`) are silenced under the flag. Drained per tick by
/// the wasm TickMovement arm and forwarded as `ClientEvent` kind 61
/// (+ the existing kind-56 jump-refusal toast).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CmdInterpEvent {
    /// Row 12 — a fresh forward-intent edge evicted the forward slot
    /// (retail `HandleNewForwardMovement`): cut the local cast gesture.
    ForwardSlotEvicted,
    /// FU-A control reclaim actually flipped control (ADJ-15 Q3
    /// instrumentation for the 1070 A/B).
    ControlReclaimed {
        /// True = the use_time pump's post-anim auto-reclaim; false = an
        /// edge-driven TakeControl. Diag-only distinction (kind-61 p2).
        via_use_time: bool,
    },
    /// Rows 12-13 — the composed drive a dispatched edge/pump installed:
    /// JS drives the forward base clip + the sidestep overlay from it.
    /// Axes are -1/0/+1 (`forward`: backstep/idle/forward, `side`:
    /// left/idle/right, `turn`: left/idle/right).
    DriveApplied {
        forward: i8,
        side: i8,
        turn: i8,
        run: bool,
    },
    /// Row-8 tail — a jump refusal (retail code) for the kind-56 toast.
    JumpRefused(u32),
}

/// A14-I2 (W3+ S10) — a pursuit entry queued at ingest (no world
/// access) and applied through the `MovementManager` facade in `tick`
/// (`MoveToManager::PerformMovement` analog, acclient.c:346123-346145).
#[derive(Debug, Clone, Copy, PartialEq)]
enum PendingPursuitCommand {
    Pursue {
        target: Guid,
        object_radius: f32,
        object_height: f32,
        run: bool,
    },
    TurnToObject {
        target: Guid,
    },
    TurnToHeading {
        heading_rad: f32,
    },
    /// `restore_manual`: a JS `CancelPursuit` restores the held manual
    /// drive (the stomp fix applies to aborts too); an explicit `Stop`
    /// does not (the player asked for an all-stop).
    Cancel {
        restore_manual: bool,
    },
    /// rynth Phase-1 — retail `MoveToPosition` type 7. The origin is the
    /// command's own pose (no target lookup, no zero-fallback risk).
    MoveToPosition {
        cell_id: Guid,
        position: holtburger_common::math::Vector3,
        run: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ActiveDriveIntent {
    Manual(MotionState),
    Autonomous(AutonomousDriveIntent),
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ActiveDriveState {
    intent: ActiveDriveIntent,
    until: Option<Instant>,
}

impl ActiveDriveState {
    fn manual(state: MotionState, until: Option<Instant>) -> Self {
        Self {
            intent: ActiveDriveIntent::Manual(state),
            until,
        }
    }

    fn autonomous(intent: AutonomousDriveIntent) -> Self {
        Self {
            intent: ActiveDriveIntent::Autonomous(intent),
            until: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ServerMotionIntent {
    state: MotionState,
    motion_style: MotionStyle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TransientMotionIntent {
    command: InterpretedMotionCommand,
    motion_style: MotionStyle,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ServerControlledProjection {
    pub target_pose: holtburger_common::position::WorldPosition,
    pub speed_mps: f32,
}

fn server_motion_intent(state: MotionState, motion_style: MotionStyle) -> ServerMotionIntent {
    ServerMotionIntent {
        state,
        motion_style,
    }
}

/// The exact inverse of [`holtburger_common::Vector3::heading_to`] — given
/// an AC heading in radians (0 = West, 90 = North, 180 = East, 270 = South,
/// matching that method's own doc comment), returns the planar (z=0) unit
/// vector that would produce it. Used ONLY by
/// [`MovementSystem::drive_local_moveto`]'s stall-recovery arm to turn a
/// perturbed heading back into a steering direction — recovers `direction`
/// from `heading` the same way `Vector3::zero().heading_to(&planar)`
/// recovers `heading` from `direction`, so
/// `direction_for_heading_rad(v.heading_to(&target)) ≈ target.normalize()`
/// round-trips (pinned by the unit test below).
fn direction_for_heading_rad(heading_rad: f32) -> Vector3 {
    let heading_deg = heading_rad.to_degrees();
    let math_deg = (450.0 - heading_deg).rem_euclid(360.0);
    let math_rad = math_deg.to_radians();
    Vector3::new(-math_rad.sin(), math_rad.cos(), 0.0)
}

impl MovementSystem {
    pub(crate) fn new() -> Self {
        Self {
            sequence_diagnostics: MovementSequenceDiagnostics::default(),
            queued_drive_commands: Vec::new(),
            pending_transient_motion: None,
            pending_arrival_pose: None,
            pending_snap_facing: None,
            active_drive: None,
            server_motion_active: false,
            last_server_motion_intent: None,
            suppress_frontend_autonomous_once: false,
            server_controlled_projection: None,
            server_controlled_projection_installed_at: None,
            next_autonomous_position_heartbeat_at: None,
            last_sent_autonomous_pose: None,
            last_sent_autonomous_contact: None,
            heartbeats_sent: 0,
            motion_table_manager: MotionTableManager::new(),
            local_motion_interp: MotionInterp::default(),
            movement_managers: HashMap::new(),
            unified_transition_runtime: false,
            faithful_transition_runtime: false,
            faithful_entity_collision_runtime: false,
            faithful_outdoor_runtime: None,
            faithful_stepup_runtime: None,
            outdoor_static_grounding_runtime: None,
            building_overlap_runtime: None,
            retail_ground_runtime: None,
            cast_move_runtime: None,
            cast_hold_reclaim_runtime: None,
            local_cast_window_active: false,
            slide_cast_runtime: None,
            cmd_interp_runtime: None,
            command_interpreter: None,
            pending_cmd_interp_sends: Vec::new(),
            motion_state_pulses_sent: 0,
            pending_cmd_interp_jump_release: false,
            cmd_interp_events: Vec::new(),
            retail_quantum_runtime: None,
            last_move_was_autonomous: false,
            pending_take_control: false,
            jump_charge: JumpChargeClock::new(),
            sticky_timeout_pending: std::cell::Cell::new(false),
            manual_moveto_cancel_pending: false,
            last_manual_drive: None,
            pending_pursuit_commands: Vec::new(),
            local_pursuit_engaged: false,
            moveto_stall: MoveToStallRecovery::default(),
            auto_run: false,
        }
    }

    /// A6-T1/T2 — install the `?unifiedTransition=on` runtime carrier
    /// (see [`USE_UNIFIED_TRANSITION`]).
    pub(crate) fn set_unified_transition(&mut self, on: bool) {
        self.unified_transition_runtime = on;
    }

    /// Phase 3 B4 — install the Phase-B `?faithfulTransition=on` runtime carrier
    /// (see [`USE_FAITHFUL_TRANSITION`]). Phase B wired the handle/URL-flag
    /// plumbing (`MovementSystemHandle::set_faithful_transition` ←
    /// `parse_faithful_transition_flag`); this is the runtime entry it targets.
    pub(crate) fn set_faithful_transition(&mut self, on: bool) {
        self.faithful_transition_runtime = on;
    }

    /// FU-3 (2026-07-20) — install the faithful-driver entity-collision runtime
    /// carrier (see [`USE_FAITHFUL_ENTITY_COLLISION`]). Default-off; test A/B
    /// and any future URL-flag plumbing target this entry.
    pub(crate) fn set_faithful_entity_collision(&mut self, on: bool) {
        self.faithful_entity_collision_runtime = on;
    }

    /// Phase 3 Phase D (2026-06-28) — install the `?faithfulOutdoor=off` runtime
    /// carrier (see [`USE_FAITHFUL_OUTDOOR`]). The wasm recv-loop init calls this
    /// once with the parsed flag (default-ON; `=off` forces the outdoor
    /// heightfield fallback). Read by the OUTDOOR branch of the faithful bridge
    /// via the `faithful_outdoor` dispatch arg threaded from
    /// [`Self::faithful_outdoor_enabled`].
    pub(crate) fn set_faithful_outdoor(&mut self, on: bool) {
        self.faithful_outdoor_runtime = Some(on);
    }

    /// Phase 3 Phase E1 / WS-D (2026-06-29) — install the `?stepUp=off` runtime
    /// carrier (see [`USE_FAITHFUL_STEPUP`]). The wasm recv-loop init calls this
    /// once with the parsed flag (default-ON; `=off` forces the pre-E1
    /// stop-at-base behavior). Read by the WS-B/WS-C climb seams via the
    /// `faithful_stepup` dispatch arg threaded from
    /// [`Self::faithful_stepup_enabled`].
    pub(crate) fn set_faithful_stepup(&mut self, on: bool) {
        self.faithful_stepup_runtime = Some(on);
    }

    /// (2026-06-30) — install the `?roofGrounding=off` runtime carrier (see
    /// [`USE_OUTDOOR_STATIC_GROUNDING`]). The wasm recv-loop init calls this once
    /// with the parsed flag (default-ON; `=off` forces the pre-2026-06-30
    /// indoor-only `ON_WALKABLE` latch). Baked into
    /// `TransitionGates::outdoor_static_grounding` at the dispatch site.
    pub(crate) fn set_outdoor_static_grounding(&mut self, on: bool) {
        self.outdoor_static_grounding_runtime = Some(on);
    }

    /// Phase 3 Phase D (2026-06-28, Option C) — install the
    /// `?buildingOverlap=off` runtime carrier (see [`USE_BUILDING_OVERLAP`]). The
    /// wasm recv-loop init calls this once with the parsed flag (default-ON;
    /// `=off` reproduces the retail home-cell-only walk-through for the A/B
    /// proof). Read at bake time via [`Self::building_overlap_enabled`].
    pub(crate) fn set_building_overlap(&mut self, on: bool) {
        self.building_overlap_runtime = Some(on);
    }

    /// (2026-07-02) — install the `?retailGround=off` runtime carrier (see
    /// [`USE_RETAIL_GROUND`]). The wasm recv-loop init calls this once with
    /// the parsed flag (default-ON; `=off` rolls the retail outdoor
    /// ground-movement port back). Baked into
    /// `TransitionGates::retail_ground` at the dispatch sites.
    pub(crate) fn set_retail_ground(&mut self, on: bool) {
        self.retail_ground_runtime = Some(on);
    }

    /// (2026-07-02) — install the `?castMove=off` runtime carrier (see
    /// [`USE_CAST_MOVE`]).
    pub(crate) fn set_cast_move(&mut self, on: bool) {
        self.cast_move_runtime = Some(on);
    }

    /// Physics-parity 2026-07-03 — install the `?retailQuantum=on`
    /// runtime carrier (see [`USE_RETAIL_QUANTUM`]; default OFF pending
    /// the DECISIONS-A1-O5 reopen + move_to turn regression at 0.2 s).
    pub(crate) fn set_retail_quantum(&mut self, on: bool) {
        self.retail_quantum_runtime = Some(on);
    }

    /// [`USE_RETAIL_GROUND`] effective predicate (const default overridden
    /// by the `?retailGround=off` runtime carrier).
    pub(crate) fn retail_ground_enabled(&self) -> bool {
        self.retail_ground_runtime.unwrap_or(USE_RETAIL_GROUND)
    }

    /// [`USE_CAST_MOVE`] effective predicate.
    pub(crate) fn cast_move_enabled(&self) -> bool {
        self.cast_move_runtime.unwrap_or(USE_CAST_MOVE)
    }

    /// (2026-07-12, WS04) — install the `?castHoldReclaim=on` runtime
    /// carrier (see [`USE_CAST_HOLD_RECLAIM`]).
    pub(crate) fn set_cast_hold_reclaim(&mut self, on: bool) {
        self.cast_hold_reclaim_runtime = Some(on);
    }

    /// [`USE_CAST_HOLD_RECLAIM`] effective predicate.
    pub(crate) fn cast_hold_reclaim_enabled(&self) -> bool {
        self.cast_hold_reclaim_runtime.unwrap_or(USE_CAST_HOLD_RECLAIM)
    }

    /// WS04 — the JS cast chain stamps its local cast window here (true at
    /// windup start, false at chain completion/fizzle/cancel). Consulted by
    /// the interpreter seam's forward lock while `?castHoldReclaim=on`.
    pub(crate) fn note_local_cast_window(&mut self, active: bool) {
        self.local_cast_window_active = active;
    }

    /// `?slideCast=off` runtime carrier install ([`USE_SLIDE_CAST`]).
    pub(crate) fn set_slide_cast(&mut self, on: bool) {
        self.slide_cast_runtime = Some(on);
    }

    /// [`USE_SLIDE_CAST`] effective predicate.
    pub(crate) fn slide_cast_enabled(&self) -> bool {
        self.slide_cast_runtime.unwrap_or(USE_SLIDE_CAST)
    }

    /// [`USE_COMMAND_INTERPRETER`] effective predicate.
    pub(crate) fn cmd_interp_enabled(&self) -> bool {
        self.cmd_interp_runtime.unwrap_or(USE_COMMAND_INTERPRETER)
    }

    /// `?cmdInterp=on/off` runtime carrier install (mirrors
    /// [`Self::set_faithful_outdoor`]'s shape). Wired through
    /// `MovementSystemHandle::set_cmd_interp` from the wasm recv-loop
    /// init.
    pub(crate) fn set_cmd_interp(&mut self, on: bool) {
        self.cmd_interp_runtime = Some(on);
    }

    /// Wave-1 step 4 — queue one raw input-action edge for the
    /// interpreter lane. The wasm `handleKeyAction` export lands here;
    /// JS calls it ONLY under `?cmdInterp=on` (the flag-off legacy lane
    /// stays byte-identical because nothing ever queues a KeyEdge).
    pub(crate) fn enqueue_key_action(&mut self, action: u32, down: bool) {
        self.queued_drive_commands
            .push(QueuedDriveCommand::KeyEdge { action, down });
    }

    /// Retail wire-latch write — `SmartBox::SetObjectMovement`
    /// (acclient.c:311185-311193) stamps `last_move_was_autonomous` with
    /// the message's autonomous flag on every accepted self motion that
    /// unpacks. Called from the `SelfServerControlledMotion` consumption
    /// site, whose emit gate (handlers/player.rs, accepted &&
    /// !is_autonomous) means this only ever LOWERS the latch for the
    /// local player — exactly retail's shape (autonomous echoes skip
    /// both the latch write and the unpack).
    pub(crate) fn note_server_authored_motion(&mut self, wire_autonomous: bool) {
        self.last_move_was_autonomous = wire_autonomous;
    }

    /// The retail autonomy dispatch predicate —
    /// `CMotionInterp::apply_current_movement` (acclient.c:344305):
    /// `true` = the INTERPRETED (server) state drives the local player
    /// this slice; `false` = raw manual input drives. `?castMove=off`
    /// forces the raw path (the pre-2026-07-02 escape hatch).
    pub(crate) fn interpreted_movement_active(&self) -> bool {
        self.cast_move_enabled() && !self.last_move_was_autonomous
    }

    /// FU5 (row 64) — retail `TakeControlFromServer`
    /// (acclient.c:716934-716953): a fresh local command while the
    /// server holds control returns control to the player —
    /// `controlled_by_server = 0` (the scene's InterpolateTo gate
    /// input, :145215) + `StopInterpolating` (the leash constraint
    /// SURVIVES — disarm is `UnConstrain` only, :389417). The autonomy
    /// latch was already raised by the edge; `StopCompletely`'s
    /// directive-cancel is the existing manual-moveto-cancel machinery.
    fn consume_pending_take_control(&mut self, world: &mut WorldState) {
        if self.pending_take_control {
            self.pending_take_control = false;
            if world.scene.local_server_controlled() {
                world.scene.set_local_server_controlled(false);
                world.stop_local_player_interpolation();
            }
        }
    }

    /// Wave-1 step 4 — one input-action edge through the retail
    /// interpreter (`?cmdInterp=on` only). The interpreter is moved OUT of
    /// `self` for the call so the seam can borrow the rest of the system +
    /// the world disjointly (the SC-15 borrow split).
    ///
    /// Ownership handover rows implemented here (PLAN table):
    /// - row 1: the seam's `do_motion`/`stop_motion`/`set_latch` are the
    ///   ONLY latch raisers on this lane (retail :317325/:317364/:716946);
    ///   `note_server_authored_motion` stays the wire-side writer.
    /// - row 2: `pending_take_control` is NEVER set here — the ported
    ///   `TakeControlFromServer` runs its full FU-A tail synchronously
    ///   (control return + leash drop through the seam + hold_run
    ///   re-assert + all-three-heads re-apply); asserted below.
    /// - row 3: `last_manual_drive` is re-derived from the interpreter's
    ///   list heads after every edge — the CommandLists ARE held-keys
    ///   truth; the mirror keeps the existing consumers (slideCast
    ///   capture, jump standstill root, autorun restore) on one path.
    /// - row 4: the composed per-axis drive REPLACES `merge_manual_edge`
    ///   (unreachable on this lane — `ManualSet` never carries keyboard
    ///   edges while the flag is on).
    /// - row 9: sends stay with the tick's edge-detector this wave — the
    ///   seam's send methods are deferred no-ops, so the A/B has identical
    ///   send cadence; step 5 flips send ownership onto the interpreter's
    ///   `SendMovementEvent` + the M1 converter.
    fn ingest_key_edge(&mut self, action: u32, down: bool, now: Instant, world: &mut WorldState) {
        if !self.cmd_interp_enabled() {
            // JS only forwards actions under ?cmdInterp=on; a stray edge
            // here means the gate leaked.
            debug_assert!(false, "KeyEdge queued while ?cmdInterp off");
            return;
        }
        // Step 5 (verdict §3.3): the `?castMove`/`?slideCast` URL flags
        // are ALIASES for the interpreter configs — seed them from the
        // runtime carriers once at construction (both parse at boot,
        // before any key edge can arrive).
        let honor_autonomy_latch = self.cast_move_enabled();
        let slidecast_persist = self.slide_cast_enabled();
        let mut interp = self.command_interpreter.take().unwrap_or_else(|| {
            let mut it = super::command_interpreter::CommandInterpreter::new(0.0);
            // Edges only arrive in-world: smartbox + player present
            // (retail SetSmartBox/NewPlayer ran during login).
            it.set_smartbox(true, true);
            it.honor_autonomy_latch = honor_autonomy_latch;
            it.slidecast_persist = slidecast_persist;
            it
        });
        // The wire-side control grabs (MoveTo/TurnTo directives, interp
        // engagement) set the SCENE flag today (they call the legacy
        // lane's machinery, not interp.lose_control_to_server, until the
        // step-5 migration) — mirror it IN so the FU-A/FU-C arms see the
        // real control state at edge time. `?castMove=off`
        // (honor_autonomy_latch false): the mirror never raises the
        // flag, so the FU-C release suppression and the FU-A stomp are
        // inert — raw input always drives (the legacy carrier's
        // `USE_CAST_MOVE=false` semantic).
        let scene_controlled = world.scene.local_server_controlled();
        interp.controlled_by_server = interp.honor_autonomy_latch && scene_controlled;
        if !interp.honor_autonomy_latch && scene_controlled {
            // The leash still returns to the player on any edge (the
            // legacy lane's latch-raising edge arms all take control
            // too) — just without the retail stomp/revival.
            world.scene.set_local_server_controlled(false);
            world.stop_local_player_interpolation();
        }

        // Base drive: the current effective manual state — unchanged axes
        // carry (retail: an edge dispatches ONE axis; the others keep
        // their last-applied slots).
        let base = match self.active_drive {
            Some(ActiveDriveState {
                intent: ActiveDriveIntent::Manual(state),
                ..
            }) => state,
            _ => MotionState {
                // Fresh lane state: run-by-default (M7 — the seam's
                // ui_toggles_run is constant-true; a Shift edge routes
                // action 0x32 → SetHoldRun which re-derives the gait).
                gait: crate::client::movement_types::Gait::Run,
                ..MotionState::default()
            },
        };
        let mut seams = SystemInterpreterSeams {
            system: self,
            world,
            now,
            drive: base,
            dispatched: false,
        };
        let handled = interp.on_action(&mut seams, action, down);
        let dispatched = seams.dispatched;
        let drive = seams.drive;
        if !handled {
            log::warn!("cmdInterp: unhandled input action {action:#x} (emote hash dark, M3)");
        }
        if dispatched {
            // Install the composed drive (the per-axis DoMotion/StopMotion
            // stream replaced merge_manual_edge — row 4).
            self.active_drive = Some(ActiveDriveState::manual(drive, None));
            let non_idle = !(drive.is_locomotion_idle() && drive.turning.is_none());
            // Row 6: non-idle interpreter drive cancels an active MoveTo
            // through the SAME flag the legacy lane uses (one consumer).
            if USE_MOVETO_DRIVER && non_idle {
                self.manual_moveto_cancel_pending = true;
            }
        }
        // Row 3: the CommandLists are held-keys truth — re-derive the raw
        // record every edge (even silent releases, which pop the lists).
        self.last_manual_drive = Some(Self::interp_held_snapshot(&interp, drive.gait));
        // Rows 12-13: forward the interpreter's effect stream + the
        // installed drive to the JS consumers (eviction first — the
        // renderer cuts, then re-bases on the new drive).
        self.drain_interp_effects(&mut interp);
        if dispatched {
            self.cmd_interp_events
                .push(Self::drive_applied_event(&drive));
        }
        // Row 2: this lane never uses the FU5 deferred-TakeControl bit.
        debug_assert!(
            !self.pending_take_control,
            "cmdInterp handover violation: interpreter edge set pending_take_control (row 2)"
        );
        self.command_interpreter = Some(interp);
    }

    /// Rows 12-13 — map the interpreter's effect ledger into the
    /// JS-facing event stream (order preserved).
    fn drain_interp_effects(
        &mut self,
        interp: &mut super::command_interpreter::CommandInterpreter,
    ) {
        use super::command_interpreter::InterpEffect;
        for effect in interp.effects.drain(..) {
            self.cmd_interp_events.push(match effect {
                InterpEffect::ForwardSlotEvicted => CmdInterpEvent::ForwardSlotEvicted,
                InterpEffect::ControlReclaimed { via_use_time } => {
                    CmdInterpEvent::ControlReclaimed { via_use_time }
                }
            });
        }
    }

    /// Rows 12-13 — the installed composed drive as a JS event payload.
    fn drive_applied_event(drive: &MotionState) -> CmdInterpEvent {
        CmdInterpEvent::DriveApplied {
            forward: match drive.forward {
                Some(ForwardLocomotion::Forward) => 1,
                Some(ForwardLocomotion::Backstep) => -1,
                None => 0,
            },
            side: match drive.sidestep {
                Some(SidestepLocomotion::StrafeRight) => 1,
                Some(SidestepLocomotion::StrafeLeft) => -1,
                None => 0,
            },
            turn: match drive.turning {
                Some(Turn::Right) => 1,
                Some(Turn::Left) => -1,
                None => 0,
            },
            run: drive.gait == crate::client::movement_types::Gait::Run,
        }
    }

    /// Step 5 — drain the interp-lane event stream (wasm TickMovement
    /// arm; empty and allocation-free when the lane is off).
    pub(crate) fn take_cmd_interp_events(&mut self) -> Vec<CmdInterpEvent> {
        std::mem::take(&mut self.cmd_interp_events)
    }

    /// Wave-1 step 5 — the per-tick retail `CommandInterpreter::UseTime`
    /// pump (acclient.c:717595), `?cmdInterp=on` only: the FU-A
    /// autonomy-latch trigger — queued input (or auto_run) while
    /// server-controlled and physics-idle reclaims control WITHOUT a
    /// fresh edge (retail: held keys survive a leash because
    /// LoseControlToServer never clears the lists). The position-event
    /// half stays closed (row 9: the heartbeat is the tick's; the seam
    /// pins `cur_time` 0.0 + `player_position_event_ready` false).
    ///
    /// Only pumps an ALREADY-CONSTRUCTED interpreter: before the first
    /// key edge there are no lists and no auto_run — nothing to
    /// reclaim — so a flag-on session that never touches the keyboard
    /// stays inert. Reclaim timing is gated by the REAL
    /// `player_motions_pending` (post-flip wave: the local registry
    /// minterp queue — see the seam impl): pure control grabs reclaim
    /// next tick; a server-authored gesture holds the gate until its
    /// node drains (renderer notify or the completion-clock shim), then
    /// held keys revive WITHOUT a fresh edge — the retail post-anim
    /// reclaim. NOTE the tick order: the registry pump runs AFTER this
    /// pump, so a shim-drained gesture releases FU-A on the FOLLOWING
    /// tick (≤ one tick of lag, same class as the channel skew).
    fn pump_cmd_interp_use_time(&mut self, now: Instant, world: &mut WorldState) {
        if !self.cmd_interp_enabled() {
            return;
        }
        let Some(mut interp) = self.command_interpreter.take() else {
            return;
        };
        // Same honor-gated control mirror as the edge ingest.
        interp.controlled_by_server =
            interp.honor_autonomy_latch && world.scene.local_server_controlled();
        let base = match self.active_drive {
            Some(ActiveDriveState {
                intent: ActiveDriveIntent::Manual(state),
                ..
            }) => state,
            _ => MotionState {
                gait: crate::client::movement_types::Gait::Run,
                ..MotionState::default()
            },
        };
        let mut seams = SystemInterpreterSeams {
            system: self,
            world,
            now,
            drive: base,
            dispatched: false,
        };
        interp.use_time(&mut seams);
        let dispatched = seams.dispatched;
        let drive = seams.drive;
        if dispatched {
            // The FU-A revival installs the composed drive exactly as
            // an edge does (rows 3/4/6). Retail sends nothing on a
            // use_time reclaim — and neither do we: the revival rides
            // the tick's edge-detector, which no-ops when the revived
            // intent matches the last sent one.
            self.active_drive = Some(ActiveDriveState::manual(drive, None));
            let non_idle = !(drive.is_locomotion_idle() && drive.turning.is_none());
            if USE_MOVETO_DRIVER && non_idle {
                self.manual_moveto_cancel_pending = true;
            }
            self.last_manual_drive = Some(Self::interp_held_snapshot(&interp, drive.gait));
        }
        // Rows 12-13: the pump's effects/drive reach JS the same way an
        // edge's do.
        self.drain_interp_effects(&mut interp);
        if dispatched {
            self.cmd_interp_events
                .push(Self::drive_applied_event(&drive));
        }
        debug_assert!(
            !self.pending_take_control,
            "cmdInterp handover violation: use_time set pending_take_control (row 2)"
        );
        self.command_interpreter = Some(interp);
    }

    /// Row 3 mirror — the interpreter's three list heads as a raw
    /// [`MotionState`] (held-keys truth for the slideCast capture, the
    /// jump standstill root, and the autorun restore).
    fn interp_held_snapshot(
        interp: &super::command_interpreter::CommandInterpreter,
        gait: crate::client::movement_types::Gait,
    ) -> MotionState {
        use super::motion_interp::{
            MOTION_RUN_FORWARD, MOTION_SIDESTEP_LEFT, MOTION_SIDESTEP_RIGHT, MOTION_TURN_LEFT,
            MOTION_TURN_RIGHT, MOTION_WALK_BACKWARDS, MOTION_WALK_FORWARD,
        };
        let forward = interp
            .substate_list
            .get_head()
            .and_then(|e| match e.command {
                MOTION_WALK_FORWARD | MOTION_RUN_FORWARD => Some(ForwardLocomotion::Forward),
                MOTION_WALK_BACKWARDS => Some(ForwardLocomotion::Backstep),
                _ => None,
            });
        let sidestep = interp
            .sidestep_list
            .get_head()
            .and_then(|e| match e.command {
                MOTION_SIDESTEP_LEFT => Some(SidestepLocomotion::StrafeLeft),
                MOTION_SIDESTEP_RIGHT => Some(SidestepLocomotion::StrafeRight),
                _ => None,
            });
        let turning = interp.turn_list.get_head().and_then(|e| match e.command {
            MOTION_TURN_LEFT => Some(Turn::Left),
            MOTION_TURN_RIGHT => Some(Turn::Right),
            _ => None,
        });
        MotionState {
            gait,
            forward,
            sidestep,
            turning,
            turn_speed: None,
        }
    }

    /// Build the drive `MotionState` from the local player's INTERPRETED
    /// motion state — retail `CMotionInterp::apply_interpreted_movement`
    /// (acclient.c:344147): the forward slot and the INDEPENDENT
    /// sidestep/turn slots each drive separately, direction carried by
    /// the signed speeds. A gesture/Ready forward slot maps to `None`
    /// (zero forward velocity via `get_state_velocity`, :343539); the
    /// sidestep/turn echo keeps flowing — slidecast. No registry entry
    /// yet = locomotion-idle. `gait`/`turn_speed` bookkeeping stays from
    /// the manual state (retail derives run from the style/holdkey;
    /// stance-speed parity is unaffected while speeds ride the wire as
    /// 1.0).
    fn interpreted_drive_state(
        interp: Option<&InterpretedState>,
        manual: MotionState,
    ) -> MotionState {
        let Some(interp) = interp else {
            return MotionState {
                forward: None,
                sidestep: None,
                turning: None,
                ..manual
            };
        };
        let forward = match interp.forward_command {
            // Locomotion commands drive with the signed speed.
            Some(InterpretedForwardCommand::WalkForward)
            | Some(InterpretedForwardCommand::RunForward) => Some(if interp.forward_speed < 0.0 {
                ForwardLocomotion::Backstep
            } else {
                ForwardLocomotion::Forward
            }),
            // FU6: a stored substate (cast gesture, crouch…) OWNS the
            // slot at zero locomotion — forward dies (the slidecast
            // asymmetry's load-bearing arm).
            Some(InterpretedForwardCommand::Substate(_)) | None => None,
        };
        let sidestep = interp.sidestep.then(|| {
            if interp.sidestep_speed < 0.0 {
                SidestepLocomotion::StrafeLeft
            } else {
                SidestepLocomotion::StrafeRight
            }
        });
        let turning = interp.turn.then(|| {
            if interp.turn_speed < 0.0 {
                Turn::Left
            } else {
                Turn::Right
            }
        });
        MotionState {
            forward,
            sidestep,
            turning,
            ..manual
        }
    }

    /// USE_CAST_MOVE per-axis edges (2026-07-03, mage-PvP strafecast) —
    /// retail's `CommandInterpreter` keeps ONE `CommandList` per axis
    /// and a key edge dispatches a SINGLE-axis `DoMotion`/`StopMotion`
    /// (`AddCommand` acclient.c:717429 pushes onto that axis's list;
    /// `NukeCommand` :717458 pops and re-dispatches the next stacked
    /// head of the SAME axis — head-wins; `HandleKeyboardCommand`
    /// routes one motion). An edge therefore never re-applies the OTHER
    /// held axes: a strafe/turn tap mid-gesture must NOT resurrect a
    /// held W — the gesture keeps the single forward slot until a
    /// FORWARD edge evicts it (`ApplyMotion` :332890/:332759). Only a
    /// full raw re-apply at EVENT boundaries (`apply_raw_movement`
    /// :344259 — landing, exhaustion, gesture MotionDone) revives every
    /// held key, and vanilla ACE's zero-gap windup cadence has no such
    /// boundary mid-cast.
    ///
    /// Merge: axes whose RAW value changed in this edge take the new
    /// raw value; unchanged axes carry the current effective drive
    /// (the interpreted mapping while the latch was low, else the
    /// previous manual effective state). No prior raw state (first
    /// input ever) = the full new state.
    fn merge_manual_edge(
        base: MotionState,
        prev_raw: Option<MotionState>,
        new_raw: MotionState,
    ) -> MotionState {
        let Some(prev) = prev_raw else {
            return new_raw;
        };
        let turn_edge =
            prev.turning != new_raw.turning || prev.turn_speed != new_raw.turn_speed;
        MotionState {
            forward: if prev.forward != new_raw.forward {
                new_raw.forward
            } else {
                base.forward
            },
            sidestep: if prev.sidestep != new_raw.sidestep {
                new_raw.sidestep
            } else {
                base.sidestep
            },
            turning: if turn_edge { new_raw.turning } else { base.turning },
            turn_speed: if turn_edge {
                new_raw.turn_speed
            } else {
                base.turn_speed
            },
            ..new_raw
        }
    }

    /// A14-I3 (`?retailRunKeys=on`) — overlay the retail autorun
    /// command onto a held manual state: `ApplyCurrentMovement`'s
    /// `auto_run` branch issues forward (cmd 0x45000005) with
    /// `hold_run=1` (acclient.c:717038-717064), ignoring the
    /// SubstateList's forward/backstep, while the Turn/Sidestep lists
    /// still apply afterward (:717066+). Mirror: force
    /// `forward=Forward` + `gait=Run`, preserve sidestep/turn.
    fn overlay_auto_run(base: MotionState) -> MotionState {
        use crate::client::movement_types::{ForwardLocomotion, Gait};
        MotionState {
            gait: Gait::Run,
            forward: Some(ForwardLocomotion::Forward),
            ..base
        }
    }

    /// A14-I3 — retail `CommandInterpreter::SetAutoRun`
    /// (acclient.c:718254-718292) + the `ApplyCurrentMovement`
    /// re-issue it triggers (:717027-717064). Same-value calls no-op
    /// (the `(val == 0) != (auto_run == 0)` edge guard, :718263).
    ///
    /// ON: cancels any S10 pursuit WITHOUT a manual restore (retail
    /// SetAutoRun(1) runs the StopMoveTo callback first, :718268)
    /// and installs the overlaid forward+Run drive. OFF: falls back
    /// to the held manual state (retail: ApplyCurrentMovement
    /// re-reads the SubstateList head, else Ready) — the recorded
    /// `last_manual_drive`, or idle when none. Reached only through
    /// the wasm `setAutoRun` bridge, which JS calls only under the
    /// default-off `?retailRunKeys=on` flag.
    pub(crate) fn set_auto_run(&mut self, on: bool) {
        if on == self.auto_run {
            return;
        }
        self.auto_run = on;
        let base = self.last_manual_drive.unwrap_or_default();
        if on {
            self.pending_pursuit_commands
                .push(PendingPursuitCommand::Cancel {
                    restore_manual: false,
                });
            self.active_drive = Some(ActiveDriveState::manual(
                Self::overlay_auto_run(base),
                None,
            ));
        } else {
            self.active_drive = Some(ActiveDriveState::manual(base, None));
        }
    }

    // ------------------------------------------------------------------
    // A14-I4 (W3+ S11) — charge clock ownership + single send boundary.
    // Retail shape: `ClientCombatSystem::CommenceJump` (press) →
    // `GetPowerBarLevel`/`GetJumpPowerLevel` (UI read) → `DoJump`
    // (release: FinishJump FIRST, then validate, then ONE JumpPack ctor
    // + counter-stamped send), acclient.c:408033-408227.
    // ------------------------------------------------------------------

    /// Press-time half — retail `CommenceJump`
    /// (acclient.c:408033-408078). The standstill-root axes check reads
    /// the active MANUAL drive (retail: `forward_command == Ready && no
    /// sidestep && no turn`, acclient.c:343864-343870) — not JS.
    pub(crate) fn jump_charge_commence(
        &mut self,
        now: Instant,
        world: &mut WorldState,
    ) -> std::result::Result<(), JumpRefusal> {
        let manual_axes_idle = match self.active_drive.map(|active| active.intent) {
            Some(ActiveDriveIntent::Manual(state)) => {
                if self.auto_run {
                    // Autorun is locomotion (the overlay forces
                    // forward=Run) — never a standstill.
                    false
                } else {
                    // Retail reads the HELD keys (:343864-343870). The
                    // castMove per-axis merge can suppress a held key
                    // from the EFFECTIVE drive (the gesture owns the
                    // slot), but a physically held key still denies the
                    // standstill root — read the raw record.
                    let raw = self.last_manual_drive.unwrap_or(state);
                    raw.is_locomotion_idle() && raw.turning.is_none()
                }
            }
            Some(ActiveDriveIntent::Autonomous(_)) => false,
            None => true,
        };
        self.jump_charge.commence(now, world, manual_axes_idle)
    }

    /// UI read — retail `GetJumpPowerLevel` (acclient.c:408081-408104):
    /// `0.0` when no charge is pending, else the bar level floored at
    /// `MIN_JUMP_EXTENT`. Published to the JS bar via the wasm
    /// `jumpChargeLevel()` shadow getter each TickMovement.
    pub(crate) fn jump_charge_power(&self, now: Instant, world: &WorldState) -> f32 {
        self.jump_charge.power(now, world)
    }

    /// Abort — retail `ACCmdInterp::FinishJump` shim →
    /// `ClientCombatSystem::FinishJump` (acclient.c:435853-435863,
    /// :407625-407648). Clears the charge + standstill root without
    /// jumping (blur analog).
    pub(crate) fn jump_charge_abort(&mut self, world: &mut WorldState) {
        self.jump_charge.finish(world);
    }

    /// Release-time half — retail `ClientCombatSystem::DoJump`
    /// autonomous branch (acclient.c:408146-408227). Body = the legacy
    /// wasm `SessionCommand::Jump` recv-arm logic MOVED (not rewritten)
    /// into the movement crate, with the pack constructed by
    /// [`build_jump`] (the A13 single-builder pattern) and dispatched
    /// via the one counter-stamped funnel `Session::send_action`
    /// (send.rs `game_action_sequence` ↔ retail OrderHdr
    /// `GetNextUICounter`). Side effect: the cli gains a jump
    /// capability for free (A13 §2 — no cli wiring in this item).
    pub(crate) async fn execute_jump_release(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
    ) -> Result<JumpOutcome> {
        use holtburger_common::stats::SkillType;
        use holtburger_world::context::WorldContextExt;

        // G-7 / F1-6 — capture the charge root BEFORE release()'s
        // FinishJump clears it; the launch-velocity choice below keys
        // off it (retail reads get_leave_ground_velocity AFTER
        // FinishJump too — the interpreted intent survives the clear).
        let charged_long_jump = world.player.standing_long_jump_charge;

        // Retail ordering (acclient.c:408164-408179): jump_pending
        // check → extent read → FinishJump → THEN validate. A refused
        // release still clears the charge + root.
        let Some(extent) = self.jump_charge.release(now, world) else {
            return Ok(JumpOutcome::NotCharging);
        };

        // Release gates — ADJ-10 (step-5 cleanup): ONE owner, retail
        // `CMotionInterp::jump_is_allowed` (acclient.c:344224-344256 →
        // :343922-343974), env-resolved for the local player exactly as
        // the previous inline chain did: grounded ≡ `!is_airborne`
        // (creature + gravity), constraint from the `?retailLeash`
        // budget, queue-head `jump_error_code` from the SAME
        // `pending_jump_error` input, posture from the server-echoed
        // substate. The weenie seams resolve PERMISSIVE (`can_jump`
        // true, no stamina refusal) — the zero-stamina FOLD below is
        // the retail InqJumpVelocity arm (acclient.c:443838-443839),
        // not a refusal; refusal codes are byte-identical to the old
        // chain for every input (36/71/head-code/72).
        let allow_env = super::motion_interp::JumpAllowEnv {
            weenie_noncreature: false,
            has_gravity: true,
            on_walkable_contact: !world.player.is_airborne,
            fully_constrained: world.local_player_fully_constrained(),
            forward_substate: world.player.current_substate,
            can_jump: true,
            has_weenie: false,
            jump_stamina_ok: true,
        };
        let refusal_code = self.local_motion_interp.jump_is_allowed(extent, &allow_env);
        if refusal_code != 0 {
            return Ok(JumpOutcome::Refused(JumpRefusal::from_code(refusal_code)));
        }

        // vz / stamina — moved verbatim from the legacy wasm Jump arm.
        // Burden flows from ACE's `EncumbranceSystem.GetBurden` via
        // `WorldContextExt::player_burden`; fallback 0.5 keeps
        // BurdenMod = 1.0 when attributes haven't hydrated yet.
        let jump_skill = world
            .player
            .skills
            .get(&SkillType::Jump)
            .map(|s| s.current as u32)
            .unwrap_or(100);
        let burden = world.player_burden().unwrap_or(0.5);
        // Retail PK arm (acclient.c:442887): PlayerKillerStatus in
        // {4, 64} AND LastPkAttackTimestamp + 20 s > server-now.
        let pk = world.player_pk_jump_stamina_arm(world.current_server_time());
        let cost = holtburger_world::player::PlayerState::jump_stamina_cost(extent, burden, pk);
        // Retail's zero-stamina fold (acclient.c:443838-443839):
        // jumpSkill treated as 0 in InqJumpVelocity → min-clamp hop,
        // so an exhausted player still pops a tiny jump.
        let stamina_current = world
            .player
            .vitals
            .get(&holtburger_common::stats::VitalType::Stamina)
            .map(|v| v.current)
            .unwrap_or(0);
        let exhausted = stamina_current == 0;
        let effective_skill =
            holtburger_world::player::PlayerState::exhausted_jump_skill(jump_skill, stamina_current);
        let vz = holtburger_world::player::PlayerState::compute_jump_velocity_z(
            extent,
            burden,
            effective_skill,
        );
        // A successful jump is a fresh AUTONOMOUS motion — retail
        // `ClientCombatSystem::DoJump` autonomous branch
        // (acclient.c:408146) → `CMotionInterp::jump`, and
        // `LeaveGround`/`HitGround` re-run `apply_current_movement`
        // in the raw path (:344457/:344429) — "jump resets the
        // movement lock". FU5: it is also an input command — retail
        // `TakeControlFromServer` (:716934-716953) fires inline.
        self.last_move_was_autonomous = true;
        if world.scene.local_server_controlled() {
            world.scene.set_local_server_controlled(false);
            world.stop_local_player_interpolation();
        }
        world.player.begin_jump(vz);
        // Deduct stamina locally (server is canonical; ACE broadcasts a
        // vital update soon after).
        if !exhausted {
            let new_current = (stamina_current as i32 - cost as i32).max(0) as u32;
            world.player.update_vital_current(
                holtburger_common::stats::VitalType::Stamina as u32,
                new_current,
                &mut Vec::new(),
            );
        }

        // Launch planar velocity: a charged (rooted) release launches
        // with the interpreted INTENT (`get_leave_ground_velocity` —
        // what the held keys at release WOULD produce); else the
        // runtime kinematics fallback. begin_jump deliberately leaves
        // current_planar_velocity untouched, so install the intent
        // there for the airborne trajectory lock.
        let lateral_velocity =
            if charged_long_jump && let Some(intent_v) = self.manual_intent_velocity(world) {
                world.player.current_planar_velocity = Vector3::new(intent_v.x, intent_v.y, 0.0);
                Vector3::new(intent_v.x, intent_v.y, vz)
            } else {
                world
                    .local_player_runtime_kinematics()
                    .map(|(_, v, _)| Vector3::new(v.x, v.y, vz))
                    .unwrap_or(Vector3::new(0.0, 0.0, vz))
            };

        // The single pack ctor + the one counter-stamped funnel
        // (retail acclient.c:408180-408193).
        let data = build_jump(world, extent, lateral_velocity);
        session
            .send_action(GameAction::Jump(Box::new(data)))
            .await?;

        Ok(JumpOutcome::Jumped {
            extent,
            vz,
            jump_skill,
            burden,
        })
    }

    /// A6-T1/T2 — the effective transition-pipeline predicate, used at
    /// every consumption site (the T1 swap in
    /// [`Self::advance_local_pose_for_manual_drive_slice`] and the T2
    /// spine arm in `client/simulation.rs`).
    pub(crate) fn unified_transition_enabled(&self) -> bool {
        USE_UNIFIED_TRANSITION || self.unified_transition_runtime
    }

    /// Phase 3 B4 — the effective faithful-transition predicate, threaded to the
    /// two `find_transitional_position` call sites (the T2 spine arm in
    /// `client/simulation.rs` and the T1 manual slice in
    /// [`Self::finish_manual_slice_via_transition`]) via the dispatcher.
    pub(crate) fn faithful_transition_enabled(&self) -> bool {
        USE_FAITHFUL_TRANSITION || self.faithful_transition_runtime
    }

    /// FU-3 — the effective faithful-driver entity-collision predicate, read at
    /// the live faithful slice ([`Self::finish_manual_slice_via_transition`]).
    /// Meaningful ONLY when [`Self::faithful_transition_enabled`] is also on (it
    /// fills the faithful driver's dynamic-entity gap).
    pub(crate) fn faithful_entity_collision_enabled(&self) -> bool {
        USE_FAITHFUL_ENTITY_COLLISION || self.faithful_entity_collision_runtime
    }

    /// Phase 3 Phase D — the effective OUTDOOR-faithful predicate. Read ONLY
    /// when [`Self::faithful_transition_enabled`] is also on (it gates the
    /// outdoor branch INSIDE the faithful bridge); WS4 threads it as the
    /// `faithful_outdoor` dispatch arg. The runtime carrier OVERRIDES the const
    /// default, so `?faithfulOutdoor=off` can roll the outdoor path back to the
    /// heightfield even while [`USE_FAITHFUL_OUTDOOR`] is `true`.
    pub(crate) fn faithful_outdoor_enabled(&self) -> bool {
        self.faithful_outdoor_runtime.unwrap_or(USE_FAITHFUL_OUTDOOR)
    }

    /// Phase 3 Phase E1 / WS-D — the effective STEP-UP-climb predicate. Read ONLY
    /// when [`Self::faithful_transition_enabled`] is also on (the climb only
    /// exists inside the faithful driver); threaded as the `faithful_stepup`
    /// dispatch arg. The runtime carrier OVERRIDES the const default, so
    /// `?stepUp=off` can roll climbing back to stop-at-base even while
    /// [`USE_FAITHFUL_STEPUP`] is `true`.
    pub(crate) fn faithful_stepup_enabled(&self) -> bool {
        self.faithful_stepup_runtime.unwrap_or(USE_FAITHFUL_STEPUP)
    }

    /// (2026-06-30) — the effective outdoor static/building grounded-latch
    /// predicate. Read ONLY when [`Self::faithful_transition_enabled`] is also on
    /// (the latch lives in the faithful driver); baked into
    /// `TransitionGates::outdoor_static_grounding` at the dispatch site. The
    /// runtime carrier OVERRIDES the const, so `?roofGrounding=off` rolls back to
    /// the indoor-only latch even while [`USE_OUTDOOR_STATIC_GROUNDING`] is `true`.
    pub(crate) fn outdoor_static_grounding_enabled(&self) -> bool {
        self.outdoor_static_grounding_runtime
            .unwrap_or(USE_OUTDOOR_STATIC_GROUNDING)
    }

    /// Phase 3 Phase D (Option C) — the effective building/static OVERLAP
    /// registration predicate, read by the per-cell static-BSP bake (WS7/WS8).
    /// The runtime carrier OVERRIDES the const default, so `?buildingOverlap=off`
    /// reproduces the retail home-cell-only behavior (the A/B bug-repro arm)
    /// even while [`USE_BUILDING_OVERLAP`] is `true`.
    pub(crate) fn building_overlap_enabled(&self) -> bool {
        self.building_overlap_runtime.unwrap_or(USE_BUILDING_OVERLAP)
    }

    pub(crate) fn note_server_controlled_movement_started(&mut self) {
        self.suppress_frontend_autonomous_once = true;
    }

    pub(crate) fn set_server_controlled_projection(
        &mut self,
        projection: ServerControlledProjection,
    ) {
        self.server_controlled_projection = Some(projection);
        // Track B1 — stamp the install time so the per-tick reconcile can
        // abandon a projection the server never closes out (dropped
        // Stop/Invalid) after `SERVER_PROJECTION_MAX_AGE`.
        self.server_controlled_projection_installed_at = Some(Instant::now());
    }

    pub(crate) fn clear_server_controlled_projection(&mut self) {
        self.server_controlled_projection = None;
        self.server_controlled_projection_installed_at = None;
    }

    fn clear_autonomous_position_heartbeat_schedule(&mut self) {
        self.next_autonomous_position_heartbeat_at = None;
    }

    pub(crate) fn arm_autonomous_position_heartbeat_schedule(
        &mut self,
        now: Instant,
        world: &WorldState,
    ) {
        self.refresh_autonomous_position_heartbeat_schedule(now, world);
    }

    fn refresh_autonomous_position_heartbeat_schedule(&mut self, now: Instant, world: &WorldState) {
        self.next_autonomous_position_heartbeat_at = has_autonomous_position_sync_target(world)
            .then_some(now + AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL);
    }

    pub(crate) fn enqueue_drive_intent(&mut self, intent: PlayerDriveIntent, now: Instant) {
        let _ = now;
        let command = match intent {
            PlayerDriveIntent::ManualHeld(state) => QueuedDriveCommand::ManualSet(state),
            PlayerDriveIntent::ManualPulse { state, duration } => {
                QueuedDriveCommand::ManualPulse { state, duration }
            }
            PlayerDriveIntent::Autonomous(intent) => QueuedDriveCommand::Autonomous(intent),
            PlayerDriveIntent::ArriveAtPose { pose } => QueuedDriveCommand::ArriveAtPose { pose },
            PlayerDriveIntent::SnapFacing { heading } => QueuedDriveCommand::SnapFacing { heading },
            PlayerDriveIntent::Stop => QueuedDriveCommand::Stop,
            PlayerDriveIntent::PursueObject {
                target,
                object_radius,
                object_height,
                run,
            } => QueuedDriveCommand::Pursue {
                target,
                object_radius,
                object_height,
                run,
            },
            PlayerDriveIntent::TurnToObject { target } => {
                QueuedDriveCommand::PursuitTurnToObject { target }
            }
            PlayerDriveIntent::TurnToHeading { heading } => {
                QueuedDriveCommand::PursuitTurnToHeading { heading }
            }
            PlayerDriveIntent::CancelPursuit => QueuedDriveCommand::CancelPursuit,
            PlayerDriveIntent::MoveToPosition {
                cell_id,
                position,
                run,
            } => QueuedDriveCommand::MoveToPosition {
                cell_id,
                position,
                run,
            },
        };

        self.queued_drive_commands.push(command);
    }

    pub(crate) fn enqueue_transient_motion(
        &mut self,
        command: InterpretedMotionCommand,
        motion_style: MotionStyle,
    ) {
        self.queued_drive_commands
            .push(QueuedDriveCommand::Transient(TransientMotionIntent {
                command,
                motion_style,
            }));
    }

    fn ingest_drive_command(&mut self, command: QueuedDriveCommand, now: Instant, local_guid: Guid) {
        match command {
            QueuedDriveCommand::ManualSet(state) => {
                // USE_CAST_MOVE — a fresh manual-input EDGE is retail's
                // `CPhysicsObj::DoMotion` / `StopMotion`
                // (`last_move_was_autonomous = 1`, acclient.c:317325 /
                // :317364 — press AND release both count): raw input
                // takes back over from the server-played interpreted
                // state until the next non-autonomous motion message
                // re-lowers the latch. Only a CHANGED state counts (a
                // re-send of the identical held axes is not an input
                // edge — retail's CommandInterpreter stacks are
                // edge-driven, :717102/:717429, a held key never
                // re-fires), so holding W does not silently defeat a
                // cast gesture — you must actively re-press ("fight the
                // cast").
                let prev_raw = self.last_manual_drive;
                // Read BEFORE the latch raise below — "was the
                // interpreted state driving when this edge arrived".
                let was_interpreted = self.interpreted_movement_active();
                if prev_raw != Some(state) {
                    self.last_move_was_autonomous = true;
                    self.pending_take_control = true;
                }
                // A14-I2 (S10 A.3) — record EVERY manual set for the
                // pursuit-end restore. Pure bookkeeping, ungated.
                self.last_manual_drive = Some(state);
                let non_idle = !(state.is_locomotion_idle() && state.turning.is_none());
                // A3-D3 driver M4.5 — non-idle manual input cancels an
                // active MoveTo (retail apply_raw_movement →
                // cancel_moveto(0x36), acclient.c:317421-317427 →
                // :339240-339246). Flag-consumed by the gated shim.
                if USE_MOVETO_DRIVER && non_idle {
                    self.manual_moveto_cancel_pending = true;
                }
                // A14-I2 — while an S10 pursuit steers, an IDLE manual
                // set (all keys released) is recorded but does NOT
                // stomp the steering drive (retail: key release does
                // not abort a MoveTo, acclient.c:345171 CleanUp-only
                // end). Non-idle still takes over (cancel above).
                if !(self.local_pursuit_engaged && !non_idle) {
                    // USE_CAST_MOVE per-axis edges (2026-07-03) — see
                    // [`Self::merge_manual_edge`]: only the CHANGED
                    // axes take the new raw value; unchanged held axes
                    // carry the current effective drive (a strafe tap
                    // mid-gesture does not resurrect a held W). `=off`
                    // keeps the full-state install.
                    let effective = if self.cast_move_enabled() {
                        let base = if was_interpreted {
                            Self::interpreted_drive_state(
                                self.movement_managers
                                    .get(&local_guid)
                                    .and_then(|manager| manager.motion_interp_ref())
                                    .map(|minterp| &minterp.interpreted_state),
                                state,
                            )
                        } else if let Some(ActiveDriveState {
                            intent: ActiveDriveIntent::Manual(prev_effective),
                            ..
                        }) = self.active_drive
                        {
                            prev_effective
                        } else {
                            state
                        };
                        Self::merge_manual_edge(base, prev_raw, state)
                    } else {
                        state
                    };
                    // A14-I3 — while `auto_run`, the effective drive
                    // keeps forward+Run regardless of the held
                    // forward/backstep keys (retail
                    // ApplyCurrentMovement prefers auto_run over the
                    // SubstateList, acclient.c:717038-717050;
                    // NukeCommand suppresses substate pops while
                    // auto_run, :717472). Sidestep/turn pass through.
                    // `last_manual_drive` above keeps the RAW state so
                    // toggling autorun off restores the actual keys.
                    let effective = if self.auto_run {
                        Self::overlay_auto_run(effective)
                    } else {
                        effective
                    };
                    self.active_drive = Some(ActiveDriveState::manual(effective, None));
                }
            }
            QueuedDriveCommand::ManualPulse { state, duration } => {
                // Local motion command — retail `DoMotion` raises the
                // autonomy latch (acclient.c:317325).
                self.last_move_was_autonomous = true;
                self.pending_take_control = true;
                self.active_drive = Some(ActiveDriveState::manual(state, Some(now + duration)));
            }
            QueuedDriveCommand::Autonomous(intent) => {
                // Client-side steering (S10 pursuit) issues autonomous
                // DoMotions in retail — the latch rises with them.
                self.last_move_was_autonomous = true;
                self.active_drive = Some(ActiveDriveState::autonomous(intent));
            }
            QueuedDriveCommand::Transient(intent) => {
                // One-shot local motion — a fresh `DoMotion` (:317325).
                self.last_move_was_autonomous = true;
                self.pending_take_control = true;
                self.pending_transient_motion = Some(intent);
            }
            QueuedDriveCommand::ArriveAtPose { pose } => {
                self.pending_arrival_pose = Some(pose);
                self.active_drive = None;
            }
            QueuedDriveCommand::SnapFacing { heading } => {
                self.pending_snap_facing = Some(heading);
            }
            QueuedDriveCommand::Stop => {
                // Local stop — retail `StopMotion`/`StopCompletely`
                // raise the latch too (acclient.c:317364).
                self.last_move_was_autonomous = true;
                self.pending_take_control = true;
                self.pending_arrival_pose = None;
                self.pending_snap_facing = None;
                self.active_drive = None;
                // A14-I2 — an explicit Stop also cancels any S10
                // pursuit (retail StopCompletely runs through
                // cancel_moveto, acclient.c:343611). No manual restore
                // — the caller asked for an all-stop.
                self.last_manual_drive = None;
                self.pending_pursuit_commands
                    .push(PendingPursuitCommand::Cancel {
                        restore_manual: false,
                    });
            }
            QueuedDriveCommand::Pursue {
                target,
                object_radius,
                object_height,
                run,
            } => {
                self.pending_pursuit_commands
                    .push(PendingPursuitCommand::Pursue {
                        target,
                        object_radius,
                        object_height,
                        run,
                    });
            }
            QueuedDriveCommand::PursuitTurnToObject { target } => {
                self.pending_pursuit_commands
                    .push(PendingPursuitCommand::TurnToObject { target });
            }
            QueuedDriveCommand::PursuitTurnToHeading { heading } => {
                self.pending_pursuit_commands
                    .push(PendingPursuitCommand::TurnToHeading {
                        heading_rad: heading,
                    });
            }
            QueuedDriveCommand::MoveToPosition {
                cell_id,
                position,
                run,
            } => {
                self.pending_pursuit_commands
                    .push(PendingPursuitCommand::MoveToPosition {
                        cell_id,
                        position,
                        run,
                    });
            }
            QueuedDriveCommand::CancelPursuit => {
                self.pending_pursuit_commands
                    .push(PendingPursuitCommand::Cancel {
                        restore_manual: true,
                    });
            }
            QueuedDriveCommand::KeyEdge { .. } => {
                // Extracted by the tick's drain loop BEFORE this dispatch
                // (the interpreter lane needs world access); unreachable
                // here.
                debug_assert!(false, "KeyEdge reached ingest_drive_command");
            }
        }
    }

    fn expire_active_drive(&mut self, now: Instant) {
        if self
            .active_drive
            .is_some_and(|active| matches!(active.intent, ActiveDriveIntent::Autonomous(_)))
        {
            self.active_drive = None;
        }

        let Some(active) = self.active_drive else {
            return;
        };

        if active.until.is_some_and(|until| now >= until) {
            log::info!(
                "movement: expiring active drive {:?} at tick {:?}",
                active.intent,
                now,
            );
            self.active_drive = None;
        }
    }

    fn autonomous_wire_motion_state(
        world: &WorldState,
        intent: AutonomousDriveIntent,
    ) -> Option<MotionState> {
        let current_heading = world
            .local_player_runtime_pose()
            .unwrap_or_default()
            .rotation
            .to_heading();
        let planar_delta = Vector3::new(
            intent.desired_world_delta.x,
            intent.desired_world_delta.y,
            0.0,
        );
        // Wave 2 Phase 2.2 (2026-05-26): autonomous drives still emit pure
        // forward locomotion — the autonomous pathfinder consumes
        // `desired_world_delta` as a single vector and only needs to
        // signal "moving forward" vs "turning in place" to observers.
        // The diagonal-composition gain applies to manual input only; if
        // an autonomous routine later needs strafe semantics it can
        // populate `state.sidestep` directly.
        let forward = (planar_delta.length_squared() > 1e-6).then_some(ForwardLocomotion::Forward);
        let desired_heading = intent.desired_heading.map(normalize_heading).or_else(|| {
            (planar_delta.length_squared() > 1e-6)
                .then(|| Vector3::zero().heading_to(&planar_delta))
        });
        let turning = if forward.is_some() {
            None
        } else {
            desired_heading.and_then(|desired_heading| {
                let delta = signed_heading_delta(current_heading, desired_heading);
                if delta.abs() <= 1e-4 {
                    None
                } else if delta > 0.0 {
                    Some(Turn::Right)
                } else {
                    Some(Turn::Left)
                }
            })
        };

        if forward.is_none() && turning.is_none() {
            return None;
        }

        // The shared solver owns local realization, but ACE still needs a
        // MoveToState edge so observers receive motion-state broadcasts.
        Some(MotionState {
            gait: intent.gait,
            forward,
            sidestep: None,
            turning,
            turn_speed: None,
        })
    }

    pub(crate) async fn tick(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
    ) -> Result<Vec<WorldEvent>> {
        // Arrival placement — at the TICK top, not only the manual-drive
        // slice: the unified tick spine (`tick_spine.rs`) deliberately skips
        // the handle's local-pose pre-integration (`note_unified_tick`), so a
        // hook placed only in `advance_local_pose_for_manual_drive_slice`
        // never runs on the spine path. `MovementSystem::tick` is the one
        // entry BOTH paths share. Idempotent (the latch self-clears).
        self.consume_pending_arrival_placement(world);
        self.reconcile_server_controlled_projection(world, now);

        // A2-P3 (2026-06-12, W3+ S9) — consume the deferred sticky
        // timeout: ACE `StickyManager.ClearTarget` also cancels the
        // MoveTo (`cancel_moveto`, StickyManager.cs:38-40); our analog
        // clears the server-controlled projection. Only set when sticky
        // was ACTUALLY active (spec S9 §5 risk row 3), and only under
        // the default-off gate.
        if USE_STICKY_MANAGER && self.sticky_timeout_pending.take() {
            self.clear_server_controlled_projection();
        }

        let had_active_manual_motion = matches!(
            self.active_drive,
            Some(ActiveDriveState {
                intent: ActiveDriveIntent::Manual(_),
                ..
            })
        );

        self.expire_active_drive(now);

        let queued = std::mem::take(&mut self.queued_drive_commands);
        if !queued.is_empty() {
            log::info!(
                "movement: ingesting {} queued drive commands at tick {:?}: {:?}",
                queued.len(),
                now,
                queued,
            );
        }
        let explicit_stop_requested = queued
            .iter()
            .any(|command| matches!(command, QueuedDriveCommand::Stop));
        // Wave-1 step 4 ownership contract (PLAN rows 1-4): when the
        // interpreter lane is on, keyboard edges arrive ONLY as KeyEdge —
        // a ManualSet in the same tick means both lanes are driving, which
        // the handover table forbids.
        debug_assert!(
            !(self.cmd_interp_enabled()
                && queued
                    .iter()
                    .any(|c| matches!(c, QueuedDriveCommand::KeyEdge { .. }))
                && queued
                    .iter()
                    .any(|c| matches!(c, QueuedDriveCommand::ManualSet(_)))),
            "cmdInterp handover violation: KeyEdge and ManualSet in one tick (both lanes driving)"
        );
        let local_guid = world.player.guid;
        for command in queued {
            if let QueuedDriveCommand::KeyEdge { action, down } = command {
                // Interpreter lane — needs world access (TakeControl's
                // leash drop), so it ingests here rather than in
                // ingest_drive_command.
                self.ingest_key_edge(action, down, now, world);
            } else {
                self.ingest_drive_command(command, now, local_guid);
            }
        }
        self.consume_pending_take_control(world);

        // Wave-1 step 5 — the retail per-frame UseTime pump (FU-A
        // reclaim of held/queued input under a pure server control
        // grab). Runs after edge ingestion (fresh edges first, retail
        // message-pump order) and before the send flush so anything it
        // queues flushes this same tick.
        self.pump_cmd_interp_use_time(now, world);

        // Wave-1 step 5 (row 9) — flush the interpreter lane's queued
        // MoveToState pulses, in dispatch order. State source: the M1
        // converter over `RawState::from_motion_state(drive)` — the
        // handoff's option (b) bridge (byte-equivalent to the legacy
        // builder for the keyboard alphabet by the M1 parity property;
        // wire ≡ pose by construction because the composed drive is the
        // ONE state truth). Option (a) — the live minterp raw_state
        // driven through the apply_motion lattice (SC-17's
        // inq_raw_motion_state) — is the retail-faithful endpoint,
        // deferred to the post-flip cleanup wave so the A/B validates a
        // single state carrier. `note_server_motion_sent` stamps the
        // same bookkeeping the legacy sender uses, so the edge-detector
        // below sees an unchanged intent and stays silent for
        // key-driven edges; non-key drive changes (FU-A use_time
        // reclaims, script ManualSets) still ride the detector — same
        // send the legacy FU5 revival produces.
        let interp_sends = std::mem::take(&mut self.pending_cmd_interp_sends);
        for state in interp_sends {
            let metadata = MovementPacketMetadata::default();
            let raw = build_raw_state_raw_motion_state(
                world,
                &super::raw_state::RawState::from_motion_state(state),
                metadata.motion_style,
            );
            let data = build_move_to_state(world, raw, metadata);
            session
                .send_action(GameAction::MoveToState(Box::new(data)))
                .await?;
            self.motion_state_pulses_sent = self.motion_state_pulses_sent.wrapping_add(1);
            self.note_server_motion_sent(server_motion_intent(state, metadata.motion_style));
        }

        // Wave-1 step 5 (row 8) — flush a queued interpreter-lane jump
        // release through the ONE release pipeline (gates → vz/stamina
        // → begin_jump → pack → send). Outcome handling mirrors the
        // legacy recv arm: refusals log (step-5.5 surfaces them as the
        // kind-56 toast); send failures propagate as tick errors.
        if std::mem::take(&mut self.pending_cmd_interp_jump_release) {
            match self.execute_jump_release(now, world, session).await? {
                JumpOutcome::NotCharging => {}
                JumpOutcome::Refused(refusal) => {
                    // Retail release-time scroll text — the same
                    // kind-56 toast the legacy release arm pushes.
                    self.cmd_interp_events
                        .push(CmdInterpEvent::JumpRefused(refusal as u32));
                }
                JumpOutcome::Jumped {
                    vz,
                    jump_skill,
                    burden,
                    ..
                } => {
                    log::info!(
                        "cmdInterp: [jump] skill={jump_skill} burden={burden:.2} → vz={vz:.2} m/s"
                    );
                }
            }
        }

        // A4-Q1 (2026-06-11): per-frame completion pump for the retail
        // `MotionTableManager` queue, run AFTER drive ingestion —
        // mirroring retail's synchronous `CheckForCompletedMotions`
        // after every `CMotionInterp::PerformMovement` arm
        // (`acclient.c:344684-344704`; ACE `MotionTableManager.cs:160`)
        // plus the per-frame `UseTime` poll (BN pseudo-C
        // `acclient_2013.bndb_pseudo_c.txt:290845-290850`), so a no-anim
        // motion completes inside the same tick it was issued. A3-D2
        // (2026-06-12): `MotionDone` events now route into the local
        // `CMotionInterp` consumer (`motion_interp.motion_done`,
        // `acclient.c:317097` → `:339349` → `:343641-343676`) — the
        // pending-motions pop + one-shot RemoveAction drain. A2-P3
        // (W3+ S9): a fired unstick hook now bubbles to the sticky
        // owner (`scene.unstick_local_player`, gated USE_STICKY_MANAGER;
        // the queue still only fills via the Stage-2 ?interpRig=
        // enqueue arms).
        // Renderer-side events (RemoveLinkAnimations) stay with A4-Q2.
        // DEFAULT-OFF ([`USE_MOTION_TABLE_QUEUE`]): queue inert, current
        // paths untouched.
        if USE_MOTION_TABLE_QUEUE {
            self.motion_table_manager.use_time(Some(now));
            for event in self.motion_table_manager.drain_events() {
                if let MotionTableEvent::MotionDone { success, .. } = event {
                    // A2-P3 (2026-06-12, W3+ S9): the unstick hook now
                    // bubbles to the sticky owner — the one-shot
                    // RemoveAction pop demanding unstick
                    // (acclient.c:343641-343676, unstick at :343659)
                    // clears the local player's sticky target. Closes
                    // the documented A3-D2 no-op.
                    let unstick = self.local_motion_interp.motion_done(success);
                    if unstick && USE_STICKY_MANAGER {
                        world.scene.unstick_local_player();
                    }
                }
            }
        }

        // Post-flip wave (2026-07-03) — the per-entity registry pump:
        // retail runs `MotionTableManager::UseTime` for EVERY object
        // EVERY frame (`CPhysicsObj::update_object_internal` →
        // `CPartArray::HandleMovement`, acclient.c:322882 →
        // :325106-325112); ours ran only on new packs / active MoveTo,
        // so the wire-stomp gesture nodes the retail
        // `move_to_interpreted_state` body now enqueues would never see
        // the completion-clock shim (`motion_table_manager.rs` module
        // doc) between packs. Local unstick bubbles exactly like the
        // system-level pump above; remote unstick requests are dropped
        // (spec §7 OQ-3 fallback — remote sticky is the F3-4 JS pin).
        {
            let local_guid = world.player.guid;
            let mut local_unstick = false;
            for (guid, manager) in self.movement_managers.iter_mut() {
                let unstick = manager.pump_completions(now);
                if unstick && *guid == local_guid {
                    local_unstick = true;
                }
            }
            if local_unstick && USE_STICKY_MANAGER {
                world.scene.unstick_local_player();
            }
        }

        if self.suppress_frontend_autonomous_once
            && matches!(
                self.active_drive,
                Some(ActiveDriveState {
                    intent: ActiveDriveIntent::Autonomous(_),
                    ..
                })
            )
        {
            log::info!(
                "movement: suppressing frontend autonomous wire motion during server-controlled movement"
            );
            self.active_drive = None;
        }
        self.suppress_frontend_autonomous_once = false;

        // A3-D3 driver (M4) — the MoveToManager per-frame pump, LOCAL
        // player only, gated default-off. Runs AFTER drive ingestion +
        // the A4-Q1 pump (the retail UseTime cadence) and BEFORE the
        // active-drive execution so a steering re-supply lands this
        // same tick through the EXISTING autonomous-drive lane
        // (`execute_autonomous_drive_intent` — zero new send sites,
        // the A13 boundary; expiry per tick matches the re-supply).
        // A14-I2 (W3+ S10, `?wasmPursuit=on`) — apply queued pursuit /
        // turn-to entries through the `MovementManager` facade BEFORE
        // the driver pump (the `MoveToManager::PerformMovement` analog,
        // acclient.c:346123-346145). Without the driver const the
        // entries fast-fail 0x36 (compose rule, url-flags.md): the
        // input lane needs `USE_MOVETO_DRIVER` to steer.
        let pursuit_stop_requested =
            self.apply_pending_pursuit_commands_inner(world, USE_MOVETO_DRIVER);

        let moveto_stop_requested = (if USE_MOVETO_DRIVER {
            self.drive_local_moveto(now, world)
        } else {
            false
        }) || pursuit_stop_requested;

        let mut events = Vec::new();
        if let Some(pose) = self.pending_arrival_pose.take() {
            events.extend(
                self.execute_arrival_pose(
                    now,
                    pose,
                    world,
                    session,
                    MovementPacketMetadata::default(),
                )
                .await?,
            );
        }
        if let Some(heading) = self.pending_snap_facing.take() {
            events.extend(
                self.execute_snap_facing(
                    now,
                    heading,
                    world,
                    session,
                    MovementPacketMetadata::default(),
                )
                .await?,
            );
        }

        let transient_sent = if let Some(intent) = self.pending_transient_motion.take() {
            self.execute_transient_motion_at(intent, world, session)
                .await?;
            true
        } else {
            false
        };

        if !transient_sent {
            match self.active_drive.map(|active| active.intent) {
                Some(ActiveDriveIntent::Manual(state)) => events.extend(
                    self.execute_motion_state_at(state, world, session, now)
                        .await?,
                ),
                Some(ActiveDriveIntent::Autonomous(intent)) => events.extend(
                    self.execute_autonomous_drive_intent(intent, world, session, now)
                        .await?,
                ),
                None if had_active_manual_motion
                    || explicit_stop_requested
                    || moveto_stop_requested =>
                {
                    // A3-D3 driver: arrival/cancel rides the EXISTING
                    // stop edge (`execute_stop_at` — ACE must see the
                    // stop; no hand-rolled sender, spec M4.2).
                    events.extend(
                        self.execute_stop_at(
                            now,
                            world,
                            session,
                            MovementPacketMetadata::default(),
                            had_active_manual_motion
                                || explicit_stop_requested
                                || moveto_stop_requested,
                        )
                        .await?,
                    );
                }
                None => {}
            }
        }

        let _ = self
            .maybe_send_autonomous_position_heartbeat(
                now,
                world,
                session,
                MovementPacketMetadata::default(),
            )
            .await?;

        Ok(events)
    }

    /// A14-I2 (W3+ S10) — apply the tick's queued pursuit commands
    /// through the `MovementManager` facade: the
    /// `MoveToManager::PerformMovement` analog for the input lane
    /// (acclient.c:346123-346145 — preamble `CancelMoveTo(0x36)` rides
    /// `MovementManager::perform_movement`). Returns `true` when a
    /// cancel left no replacement steering and owes the stop edge.
    ///
    /// `driver_enabled` carries [`USE_MOVETO_DRIVER`] (the `_ungated`
    /// house test seam passes `true`): without the driver the entries
    /// install-then-fast-fail 0x36 so the JS monitor cancels promptly
    /// instead of spinning to its wall-clock timeout (compose rule —
    /// `?wasmPursuit` requires a `USE_MOVETO_DRIVER` build to steer;
    /// documented in url-flags.md).
    fn apply_pending_pursuit_commands_inner(
        &mut self,
        world: &mut WorldState,
        driver_enabled: bool,
    ) -> bool {
        use holtburger_protocol::messages::movement::messages::motion::Origin;

        if self.pending_pursuit_commands.is_empty() {
            return false;
        }
        let commands = std::mem::take(&mut self.pending_pursuit_commands);
        let guid = world.player.guid;
        if guid == Guid::NULL {
            return false;
        }
        let on_contact = !world.player.is_airborne;
        let mut stop_requested = false;
        for command in commands {
            let mut effects = MotionSideEffects::default();
            match command {
                PendingPursuitCommand::Cancel { restore_manual } => {
                    let Some(manager) = self.movement_managers.get_mut(&guid) else {
                        continue;
                    };
                    let was_active = manager.is_moveto_active();
                    let out = manager.cancel_moveto_with_effects(WE_ACTION_CANCELLED, on_contact, &mut effects);
                    self.local_pursuit_engaged = false;
                    if was_active {
                        if restore_manual {
                            stop_requested |=
                                self.finish_pursuit_with_manual_restore(out.stop_completely);
                        } else {
                            stop_requested |= out.stop_completely;
                        }
                    }
                }
                entry => {
                    // A14-I2 arbitration: installing a pursuit takes the
                    // wire over from a HELD manual drive (it stays
                    // recorded in `last_manual_drive` for the
                    // pursuit-end restore). A non-idle ManualSet that
                    // arrived the SAME tick wins instead (retail raw
                    // input cancels MoveTo, acclient.c:339240) — the
                    // gated shim consumes `manual_moveto_cancel_pending`
                    // right after this and cancels the fresh install.
                    if driver_enabled
                        && !self.manual_moveto_cancel_pending
                        && matches!(
                            self.active_drive,
                            Some(ActiveDriveState {
                                intent: ActiveDriveIntent::Manual(_),
                                ..
                            })
                        )
                    {
                        self.active_drive = None;
                    }
                    // Target origin: resolved entity pose when known;
                    // `target_exists` stays TRUE either way — a missing
                    // target deliberately resolves through the driver's
                    // per-tick lookup → `cancel_moveto(0x37)` next frame
                    // (acclient.c:346086; the spec-C "let the wasm side
                    // fail it" path), never the case-6 LABEL_15
                    // walk-to-stale-origin fallback.
                    let target_guid = match entry {
                        PendingPursuitCommand::Pursue { target, .. }
                        | PendingPursuitCommand::TurnToObject { target } => Some(target),
                        _ => None,
                    };
                    let origin = target_guid
                        .and_then(|t| world.entities.get(t))
                        .map(|entity| Origin {
                            cell_id: entity.position.landblock_id,
                            position: entity.position.coords,
                        })
                        .unwrap_or(Origin {
                            cell_id: Guid(0),
                            position: holtburger_common::math::Vector3::new(0.0, 0.0, 0.0),
                        });
                    let mvs = match entry {
                        PendingPursuitCommand::Pursue {
                            target,
                            object_radius,
                            object_height,
                            run,
                        } => {
                            let mut params = MovementParameters::default();
                            if run {
                                // ForceRun (`bitfield |= 0x10` →
                                // hold_key Run in get_command,
                                // acclient.c:346213-346215) — today's
                                // `run=true` charge behavior exactly.
                                params.bitfield |= 0x10;
                            }
                            MovementStruct::MoveToObject {
                                target,
                                target_exists: true,
                                origin,
                                object_radius,
                                object_height,
                                params,
                            }
                        }
                        PendingPursuitCommand::TurnToObject { target } => {
                            MovementStruct::TurnToObject {
                                target,
                                target_exists: true,
                                params: MovementParameters::default(),
                            }
                        }
                        PendingPursuitCommand::TurnToHeading { heading_rad } => {
                            let mut params = MovementParameters::default();
                            // RADIANS (pose domain) → the retail
                            // degrees domain, [0, 360).
                            params.desired_heading =
                                heading_rad.to_degrees().rem_euclid(360.0);
                            MovementStruct::TurnToHeading { params }
                        }
                        PendingPursuitCommand::MoveToPosition {
                            cell_id,
                            position,
                            run,
                        } => {
                            // rynth Phase-1 — retail case 7
                            // (acclient.c:346133-346135). Origin comes
                            // from the command itself, not the entity
                            // lookup above.
                            let mut params = MovementParameters::default();
                            if run {
                                params.bitfield |= 0x10;
                            }
                            MovementStruct::MoveToPosition {
                                origin: Origin { cell_id, position },
                                params,
                            }
                        }
                        PendingPursuitCommand::Cancel { .. } => unreachable!("handled above"),
                    };
                    let manager = self.movement_managers.entry(guid).or_default();
                    let _ = manager.perform_movement(&mvs, on_contact, None, &mut effects);
                    // Drop the preamble/stale completion latch — a
                    // replaced directive's 0x36 (or an unread prior
                    // arrival) must not read as THIS pursuit's result
                    // (S10 A.4 "latch until the next pursuit starts").
                    let _ = manager.take_moveto_completion();
                    if driver_enabled {
                        self.local_pursuit_engaged = true;
                    } else {
                        // Compose fast-fail: no driver, nothing will
                        // ever steer this directive — latch 0x36 now.
                        let _ =
                            manager.cancel_moveto_with_effects(WE_ACTION_CANCELLED, on_contact, &mut effects);
                        self.local_pursuit_engaged = false;
                    }
                }
            }
        }
        stop_requested
    }

    /// A14-I2 test seam (`_ungated` house pattern) — apply pursuit
    /// commands as if [`USE_MOVETO_DRIVER`] were on.
    #[cfg(test)]
    pub(crate) fn apply_pending_pursuit_commands_ungated(
        &mut self,
        world: &mut WorldState,
    ) -> bool {
        self.apply_pending_pursuit_commands_inner(world, true)
    }

    /// A14-I2 (S10 A.3) — THE stomp fix: when a pursuit ends (arrival,
    /// failure, or JS abort), re-install the last recorded manual
    /// drive if it is non-idle (retail parity: manual movement and
    /// MoveTo are separate channels — a held W survives a MoveTo's
    /// end, acclient.c:346123/:339240 arbitration); otherwise the
    /// caller owes the existing stop edge (`execute_stop_at` — ACE
    /// must still see the stop, DESIGN.md wire invariants). Returns
    /// the stop-edge request.
    fn finish_pursuit_with_manual_restore(&mut self, stop_completely: bool) -> bool {
        self.local_pursuit_engaged = false;
        self.moveto_stall = MoveToStallRecovery::default();
        if let Some(state) = self.last_manual_drive
            && !(state.is_locomotion_idle() && state.turning.is_none())
        {
            self.active_drive = Some(ActiveDriveState::manual(state, None));
            false
        } else {
            // Drop any lingering steering intent so the post-drive
            // execution can't re-emit one frame of autonomous steer
            // toward a finished pursuit (per-tick expiry would clear
            // it next tick anyway — this is the same-tick belt).
            if matches!(
                self.active_drive,
                Some(ActiveDriveState {
                    intent: ActiveDriveIntent::Autonomous(_),
                    ..
                })
            ) {
                self.active_drive = None;
            }
            stop_completely
        }
    }

    /// A3-D3 driver (M4.1/M4.2) — one MoveTo driver frame for the
    /// LOCAL player. Returns `true` when a stop edge is owed this tick
    /// (arrival / cancel with no replacement steering). Only reachable
    /// under [`USE_MOVETO_DRIVER`].
    ///
    /// View sources (spec M4.1):
    /// - contact: `!world.player.is_airborne` — the same bit the wire
    ///   `last_contact` byte reads (`on_contact` site below; spec §7
    ///   Q3 fallback, retail `transient_state & 1` acclient.c:346024);
    /// - pose: `local_player_runtime_pose` (the autonomous lane's own
    ///   pose source);
    /// - target pose: per-tick entity lookup (the client-side
    ///   `HandleUpdateTarget` cadence); target gone →
    ///   `cancel_moveto(0x37)` (acclient.c:346086);
    /// - dims: `PLAYER_CAPSULE_RADIUS`/`PLAYER_CAPSULE_HEIGHT`
    ///   (cylinder-metric self half, acclient.c:344877-344878);
    /// - `motions_pending`: the registry manager's own lattice;
    /// - `is_interpolating`: the local body's position-manager queue
    ///   (A2 lane).
    fn drive_local_moveto(&mut self, now: Instant, world: &mut WorldState) -> bool {
        let guid = world.player.guid;
        if guid == Guid::NULL {
            return false;
        }
        let manual_cancel = std::mem::take(&mut self.manual_moveto_cancel_pending);
        let Some(manager) = self.movement_managers.get_mut(&guid) else {
            self.local_pursuit_engaged = false;
            self.moveto_stall = MoveToStallRecovery::default();
            return false;
        };
        if !manager.is_moveto_active() {
            self.local_pursuit_engaged = false;
            self.moveto_stall = MoveToStallRecovery::default();
            return false;
        }
        let on_contact = !world.player.is_airborne;
        let mut effects = MotionSideEffects::default();

        // M4.5 manual-cancel parity: a non-idle ManualSet ingested this
        // tick, OR a held non-idle manual drive, wins over the driver —
        // the manual lane owns the wire; no stop edge here.
        let manual_active = matches!(
            self.active_drive.map(|active| active.intent),
            Some(ActiveDriveIntent::Manual(state))
                if !(state.is_locomotion_idle() && state.turning.is_none())
        );
        if manual_cancel || manual_active {
            let _ = manager.cancel_moveto_with_effects(WE_ACTION_CANCELLED, on_contact, &mut effects);
            self.local_pursuit_engaged = false;
            self.moveto_stall = MoveToStallRecovery::default();
            return false;
        }

        let Some(self_pos) = world.local_player_runtime_pose() else {
            return false;
        };

        // Per-tick target refresh — the HandleUpdateTarget cadence;
        // a despawned target cancels 0x37 (acclient.c:346086) and owes
        // the stop edge.
        let target_pos = match manager.moveto_directive_target() {
            Some(target) => match world.entities.get(target) {
                Some(entity) => Some(entity.position),
                None => {
                    let out = manager.cancel_moveto_with_effects(0x37, on_contact, &mut effects);
                    // A14-I2 (S10 A.3) — target loss ends the pursuit:
                    // restore a held manual drive, else owe the stop.
                    return self.finish_pursuit_with_manual_restore(out.stop_completely);
                }
            },
            None => None,
        };

        let view = MoveToView {
            on_walkable_contact: on_contact,
            self_pos,
            self_radius: PLAYER_CAPSULE_RADIUS,
            self_height: PLAYER_CAPSULE_HEIGHT,
            target_pos,
            motions_pending: manager.moveto_motions_pending(),
            is_interpolating: world.scene.local_player_is_interpolating(),
            now,
        };
        let out = manager.use_time_moveto(&view, &mut effects);
        // A14-I2 — directive ended THIS frame (arrival Some(0) or a
        // driver-side failure latch): the restore arbitration below
        // keys off this, NOT off `out.completion` (which mirrors a
        // possibly-stale unread latch).
        let pursuit_ended = !manager.is_moveto_active();

        // Output translation (spec M4.2) — every edge rides an EXISTING
        // path; the driver never writes a position and never sends.
        if let Some(heading_rad) = out.set_heading {
            // Retail snaps exactly at turn arrival (acclient.c:345746)
            // — the existing snap path (`execute_snap_facing`).
            self.pending_snap_facing = Some(heading_rad);
        }
        if let Some((target, radius, _height)) = out.stick_to {
            // Sticky-bit arrival → the S9 sticky owner. OQ2 fallback:
            // landed `stick_to(target, target_radius)` takes radius
            // only (position_manager.rs) — the retail height param
            // (acclient.c:345565) is DROPPED here; extending the S9
            // signature is S9's call (spec §7 Q2).
            if USE_STICKY_MANAGER {
                world.scene.stick_local_player_to(target, radius);
            }
        }
        match out.steer {
            Some(MoveToSteer::Walk { target, away, run }) => {
                let to_target = target.global_coords() - self_pos.global_coords();
                let planar = Vector3::new(to_target.x, to_target.y, 0.0);
                if planar.length_squared() > 1e-6 {
                    // (2026-07-20) Driver-level stall recovery (BOT-ONLY,
                    // see stall_recovery.rs) — perturb the direct bearing
                    // off-axis when the steer has realized near-zero
                    // displacement for several ticks running, so
                    // slide_sphere sees a non-orthogonal input component
                    // and can shear the mover off a blocking plane instead
                    // of wedging forever. `0.0` = ordinary direct steering
                    // (the overwhelmingly common case).
                    let recovery_offset = self.moveto_stall.poll(self_pos, target, now);
                    let mut heading = Vector3::zero().heading_to(&planar);
                    let mut direction = planar.normalize();
                    if recovery_offset != 0.0 {
                        heading = normalize_heading(heading + recovery_offset);
                        direction = direction_for_heading_rad(heading);
                    }
                    // Unit-forward toward the target (spec M4.2);
                    // negated when moving away — the away walk faces
                    // away from the target (the 180° desired-heading
                    // table, acclient.c:346224-346239). Realized speed
                    // is the lane/integrator's policy (spec §7 Q4
                    // spirit) — eye-test item.
                    let (delta, desired_heading) = if away {
                        (
                            direction * -1.0,
                            normalize_heading(heading + std::f32::consts::PI),
                        )
                    } else {
                        (direction, heading)
                    };
                    self.active_drive = Some(ActiveDriveState::autonomous(AutonomousDriveIntent {
                        desired_world_delta: delta,
                        desired_heading: Some(desired_heading),
                        target_hint: (!away).then_some(target),
                        gait: if run {
                            crate::client::movement_types::Gait::Run
                        } else {
                            crate::client::movement_types::Gait::Walk
                        },
                        force_grounded: false,
                    }));
                }
                false
            }
            Some(MoveToSteer::Turn { heading_deg }) => {
                // Turn-in-place: zero delta + desired heading (the
                // lane's turning realization). Turn omega magnitude =
                // integrator policy, NOT re-derived here (spec §7 Q4).
                self.active_drive = Some(ActiveDriveState::autonomous(AutonomousDriveIntent {
                    desired_world_delta: Vector3::zero(),
                    desired_heading: Some(normalize_heading(heading_deg.to_radians())),
                    target_hint: None,
                    gait: crate::client::movement_types::Gait::Walk,
                    force_grounded: false,
                }));
                false
            }
            None => {
                if pursuit_ended {
                    // A14-I2 (S10 A.3) — THE stomp fix: a held W
                    // survives the pursuit's end (restore), else the
                    // arrival/cancel stop edge rides as landed.
                    self.finish_pursuit_with_manual_restore(out.stop_completely)
                } else {
                    out.stop_completely
                }
            }
        }
    }

    /// A3-D3 consumer surface (M4.4 / S10 A.3) — the local player's
    /// MoveTo activity, read from the registry manager.
    pub(crate) fn moveto_is_active(&self, guid: Guid) -> bool {
        self.movement_managers
            .get(&guid)
            .is_some_and(|manager| manager.is_moveto_active())
    }

    /// A3-D3 consumer surface (M4.4 / S10 A.4) — read-clear completion
    /// latch (`Some(0)` arrival; 0x36/0x3D/0x37/0x38/8 failures).
    pub(crate) fn take_moveto_completion(&mut self, guid: Guid) -> Option<u32> {
        self.movement_managers
            .get_mut(&guid)
            .and_then(|manager| manager.take_moveto_completion())
    }

    /// A14-I2 (S10 A.4) — the poll-shaped pursuit status the wasm
    /// `pursuitStatus()` export publishes (retail is callback-shaped —
    /// `CleanUpAndCallWeenie`, acclient.c:345171 — the poll getter is
    /// the bridge-pattern analog, S10 §6.5). Encoding (low 16 bits =
    /// state, high 16 = WEENIE error on failure):
    /// - `0` idle (no pursuit, no unread completion);
    /// - `1` active;
    /// - `2` arrived (completion `Some(0)` — READ-CLEAR);
    /// - `3 | (err << 16)` failed (0x36/0x3D/0x37/0x38/8 — READ-CLEAR).
    pub(crate) fn pursuit_status(&mut self, guid: Guid) -> u32 {
        if self.moveto_is_active(guid) {
            return 1;
        }
        match self.take_moveto_completion(guid) {
            Some(0) => 2,
            Some(err) => 3 | (err << 16),
            None => 0,
        }
    }

    pub(crate) fn current_local_drive_control(
        &self,
        world: &WorldState,
        dt: Duration,
    ) -> Option<LocalDriveControl> {
        if world.player.guid == Guid::NULL {
            return None;
        }

        let body_id = SpatialBodyId::LocalPlayer(world.player.guid);

        // Track B1 — suppress-while-steering. The projection drive STACKS
        // additively on top of manual WASD integration (both consume this
        // tick), so while the user is actively steering (Manual active
        // drive) we must NOT also apply the server-controlled projection
        // drive — otherwise the two deltas fight and the avatar is dragged
        // off the player's input. When the user is steering, the projection
        // is left installed (it is cleared by the reconcile on
        // completion / divergence / staleness) but its drive is skipped.
        let manual_active = matches!(
            self.active_drive,
            Some(ActiveDriveState {
                intent: ActiveDriveIntent::Manual(_),
                ..
            })
        );

        if let Some(projection) = self.server_controlled_projection.filter(|_| !manual_active) {
            let current_pose = world.local_player_runtime_pose().unwrap_or_default();
            let to_target = projection.target_pose.global_coords() - current_pose.global_coords();
            let max_step = (projection.speed_mps.max(0.1) * dt.as_secs_f32().max(0.001)).max(0.05);
            let desired_world_delta = if to_target.length_squared() <= 1e-6 {
                Vector3::zero()
            } else {
                let distance = to_target.length();
                if distance <= max_step {
                    to_target
                } else {
                    to_target.normalize() * max_step
                }
            };

            let desired_heading = if desired_world_delta.length_squared() > 1e-6 {
                Some(current_pose.heading_to(&projection.target_pose))
            } else {
                Some(projection.target_pose.rotation.to_heading())
            };

            return Some(LocalDriveControl {
                body_id,
                desired_world_delta,
                desired_heading,
                // Projection reconcile keeps the instant-heading shape.
                turn_omega_rad_s: None,
                target_hint: Some(projection.target_pose),
                gait: if projection.speed_mps > 1.0 {
                    LocalDriveGait::Run
                } else {
                    LocalDriveGait::Walk
                },
                force_grounded: true,
            });
        }

        let intent = match self.active_drive?.intent {
            ActiveDriveIntent::Autonomous(intent) => intent,
            ActiveDriveIntent::Manual(_) => return None,
        };

        // The steer arms (`drive_local_moveto`) store a UNIT direction —
        // "realized speed is the lane's policy" (spec §7 Q4). This seam is
        // that policy: scale by the authored MotionTable gait speed × dt
        // (the same speed source the manual lane's
        // `interpreted_velocity_for_state` realizes for RunForward /
        // WalkForward), honoring this function's contract that
        // `desired_world_delta` is pre-scaled per-slice (handle.rs tick
        // doc). Unresolvable capabilities freeze the drive exactly like
        // the manual slice's early-return (`advance_local_pose_for_
        // manual_drive_slice`).
        let capabilities = world.resolve_self_movement_capabilities().ok()?;
        let speed_mps = match intent.gait {
            crate::client::movement_types::Gait::Run => capabilities.resolved_manual_run_speed(),
            crate::client::movement_types::Gait::Walk => capabilities.base_walk_forward_speed(),
        };
        let turn_omega = {
            let base = capabilities.base_turn_right_speed_rad_per_sec();
            match intent.gait {
                crate::client::movement_types::Gait::Run => base * RUN_TURN_FACTOR,
                crate::client::movement_types::Gait::Walk => base,
            }
        };

        Some(LocalDriveControl {
            body_id,
            desired_world_delta: intent.desired_world_delta * (speed_mps * dt.as_secs_f32()),
            desired_heading: intent.desired_heading,
            turn_omega_rad_s: Some(turn_omega),
            target_hint: intent.target_hint,
            gait: match intent.gait {
                crate::client::movement_types::Gait::Walk => LocalDriveGait::Walk,
                crate::client::movement_types::Gait::Run => LocalDriveGait::Run,
            },
            force_grounded: intent.force_grounded,
        })
    }

    /// Phase 4 step 3.6 — advance the local-player runtime pose by
    /// `velocity * dt` if the active drive is `Manual`. The cli's
    /// full flow runs this implicitly via `simulation::tick` →
    /// `current_local_solve_body_input` → `SpatialPhysics::solve` →
    /// `apply_solved_body_kinematics`. The wasm bundle skips the
    /// solver to keep the bundle small; this thin integrator is just
    /// enough to keep the WorldState pose advancing so
    /// `AutonomousPosition` heartbeats carry a current position.
    /// No-op when active drive is None / Autonomous (Autonomous
    /// already gets its delta via `current_local_drive_control`).
    ///
    /// Physics deep-dive 2026-06-01 (gaps 1 + 7): this is the
    /// clamp-and-subdivide entry point. The raw per-frame `dt` is
    /// bounded and split into `<= MAX_QUANTUM` slices before being
    /// fed to [`advance_local_pose_for_manual_drive_slice`], mirroring
    /// ACE's `update_object` timestep gate
    /// (`external/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:4140-4190`).
    /// Under [`USE_RETAIL_QUANTUM`] the ACE shape is swapped for the
    /// retail loop ([`retail_quantum_schedule`]).
    /// Gravity, friction (`pow(1-f, q)` composes correctly per-slice),
    /// the terminal-velocity clamp, and collision all run per slice,
    /// so a frame-hitch can no longer over-integrate a fall in one
    /// giant step. Gated behind
    /// [`USE_QUANTUM_SUBDIVIDED_INTEGRATION`] (default on); when off,
    /// the old single-step path is preserved for A/B.
    pub(crate) fn advance_local_pose_for_manual_drive(&self, world: &mut WorldState, dt: Duration) {
        if !USE_QUANTUM_SUBDIVIDED_INTEGRATION {
            // Legacy single-step path (pre-2026-06-01). Retained
            // behind the flag for A/B comparison of the subdivided
            // loop. Consumes the raw, unbounded `dt` in one step.
            self.advance_local_pose_for_manual_drive_slice(world, dt);
            return;
        }

        if self.retail_quantum_enabled() {
            // Retail update_object loop (acclient.c:323123-323161) — the
            // banked carry rides the same accumulator field; retail's
            // `dt = cur_time − update_time` includes prior carry the
            // same way. Consume-skip / huge arms return carry 0.0
            // (update_time = cur_time).
            let total = world.player.physics_time_accumulator + dt.as_secs_f32();
            let (slices, carry) = retail_quantum_schedule(total);
            for quantum in slices {
                self.advance_local_pose_for_manual_drive_slice(
                    world,
                    Duration::from_secs_f32(quantum),
                );
            }
            world.player.physics_time_accumulator = carry;
            return;
        }

        // Accumulate the incoming frame time with any sub-MIN_QUANTUM
        // tail carried from prior frames. Mirrors ACE's `update_object`
        // measuring `deltaTime = CurrentTime - UpdateTime` and only
        // advancing `UpdateTime` by the *consumed* time
        // (`PhysicsObj.cs:4159-4188`) — so a stream of 60 Hz (16 ms)
        // frames accumulates here until it crosses MIN_QUANTUM and a
        // slice is integrated, matching retail's 30 Hz physics gate.
        let total = world.player.physics_time_accumulator + dt.as_secs_f32();

        // `quantum_slices` returns `None` when the accumulated time is
        // a HugeQuantum hitch (dropped, no integration; the consumed
        // time is reset below so a multi-second stall can't replay) and
        // otherwise the bounded `<= MAX_QUANTUM` slice schedule. Each
        // slice runs the full gravity / friction / collision
        // integration so the per-slice motion is bounded and a
        // frame-hitch can no longer over-integrate a fall in one step.
        let Some(slices) = quantum_slices(total) else {
            // HugeQuantum: consume the time without integrating
            // (`PhysicsObj.cs:4169-4173` sets `UpdateTime = CurrentTime`).
            world.player.physics_time_accumulator = 0.0;
            return;
        };
        let consumed: f32 = slices.iter().sum();
        for quantum in slices {
            self.advance_local_pose_for_manual_drive_slice(world, Duration::from_secs_f32(quantum));
        }
        // Carry the sub-MIN_QUANTUM tail to the next frame. ACE leaves
        // this remainder in the timer (`UpdateTime` advanced only by
        // the integrated slices).
        world.player.physics_time_accumulator = (total - consumed).max(0.0);
    }

    /// F1/F2 — effective predicate for the retail quantum loop shape:
    /// the [`USE_RETAIL_QUANTUM`] const default overridden by the
    /// `?retailQuantum=on` runtime carrier. Both call sites (this file
    /// + client/simulation.rs) read through here.
    pub(crate) fn retail_quantum_enabled(&self) -> bool {
        self.retail_quantum_runtime.unwrap_or(USE_RETAIL_QUANTUM)
    }

    /// F1/F2 — [`retail_quantum_schedule`] surfaced for the tick spine
    /// (client/simulation.rs), which reaches this module only through
    /// the `MovementSystem` re-export.
    pub(crate) fn retail_quantum_schedule(dt_secs: f32) -> (Vec<f32>, f32) {
        retail_quantum_schedule(dt_secs)
    }

    /// One bounded integration slice (`quantum <= MAX_QUANTUM`).
    /// Factored out of [`advance_local_pose_for_manual_drive`] by the
    /// physics deep-dive 2026-06-01 quantum-subdivision work; the
    /// caller bounds and subdivides the incoming frame `dt` and feeds
    /// each slice here. The body is the original per-frame integrator
    /// (friction smoothing, lateral collision clamp, airborne gravity
    /// arc, floor-Z snap, rotation prediction) advanced by exactly one
    /// quantum.
    fn advance_local_pose_for_manual_drive_slice(&self, world: &mut WorldState, dt: Duration) {
        // Arrival placement — BEFORE the first transition slice. A teleport /
        // force-blip resync can land the capsule embedded in an env-cell wall;
        // retail de-embeds it with a PLACEMENT transition on arrival
        // (`find_placement_position`, acclient.c:313341). Runs once per pending
        // arrival (self-clears), so the movement below sweeps from the corrected
        // pose.
        self.consume_pending_arrival_placement(world);
        // A6-T1 (W3+ S7) — under the unified-transition gate the slice
        // routes through the retail substep pipeline; the legacy chain
        // below runs UNTOUCHED when the gate is off (zero code motion).
        if self.unified_transition_enabled() {
            let _ = self.advance_manual_slice_via_transition(world, dt);
            return;
        }
        let Some(active) = self.active_drive else {
            return;
        };
        let ActiveDriveIntent::Manual(state) = active.intent else {
            return;
        };
        let Some(mut pose) = world.local_player_runtime_pose() else {
            return;
        };
        // F4-2 (bughunt 2026-06-09) — slice-entry landblock-local XY, captured
        // before any lateral move, so the outdoor walkable-slope gate can
        // revert an uphill advance onto a non-walkable cliff face. Same frame
        // as `pose.coords` throughout the slice (rebucket runs only at the
        // end), so the revert is consistent.
        let entry_local_xy = (pose.coords.x, pose.coords.y);
        let heading = pose.rotation.to_heading();
        let capabilities = match world.resolve_self_movement_capabilities() {
            Ok(c) => c,
            Err(_) => return,
        };
        // STAGE 1 (2026-06-11) velocity-source swap: under the gate the
        // planar target comes from the CMotionInterp port (raw →
        // interpreted → authored-cycle-base × speed_mod, DESIGN.md §2);
        // the legacy axis helpers stay the default path and the gate-OFF
        // identity is pinned by the motion_interp identity test. ONLY
        // where this number comes from changes — the 30 Hz slicing,
        // step-up/down, edge-slide, ground-snap and collision paths below
        // consume it unchanged.
        let target_velocity = if USE_INTERPRETED_VELOCITY {
            interpreted_velocity_for_state(heading, state, &capabilities)
        } else {
            local_velocity_for_state(heading, state, &capabilities)
        };
        // G-7 / F1-6 — StandingLongJump root: while a standstill jump
        // charge is held the locomotion target is suppressed (turning
        // stays allowed via `omega` below), mirroring retail
        // `DoInterpretedMotion`'s StandingLongJump branch
        // (MotionInterp.cs:458-476). Inert unless the wasm
        // `jumpChargeBegin` export set the flag (?longJump=on).
        let target_velocity = if world.player.standing_long_jump_charge {
            Vector3::zero()
        } else {
            target_velocity
        };
        // Phase 2 (Cohere-D, 2026-05-12): also compute angular velocity
        // from the manual drive state so we can apply local rotation
        // prediction below. Prior to this, the manual integrator only
        // updated `pose.coords` — `pose.rotation` was left server-
        // authoritative, so Q/E felt dead until the next
        // `UpdateMotion` broadcast roundtrip (50-200 ms latency).
        // Mirrors how the 2D path's per-rAF prediction tick locally
        // integrates heading at `index.html:6388-6395`.
        let omega = local_omega_for_state(state, &capabilities);
        let dt_s = dt.as_secs_f32();

        // Wave 10 Phase 10.3 (2026-05-26): friction-decay + accel-cap
        // velocity smoothing.
        //
        // Prior waves used `target_velocity` directly for the per-tick
        // delta — input changes flipped the velocity vector instantly.
        // The smell-test scenario (jump backwards, hold W on touchdown)
        // teleported the player's lateral velocity from -backward to
        // +forward in a single tick, which read as a visual snap.
        //
        // The retail behaviour, per `CPhysicsObj::calc_friction` at
        // `external/GDL/PhatSDK/PhysicsObj.cpp:521-561`, is a per-tick
        // multiplicative decay on `m_velocityVector` gated by
        // `transient_state & ON_WALKABLE_TS` (`PhysicsObj.cpp:523`).
        // Acceleration is applied separately via `m_Acceleration` in
        // `UpdatePhysicsInternal` (`PhysicsObj.cpp:594-598`). We don't
        // port the full retail pipeline (the `apply_raw_movement` chain
        // sets `m_velocityVector` to the input target directly, then
        // friction-decays it); instead we approximate the
        // smoothing-toward-target with a per-axis accel cap and a
        // gentler friction coefficient
        // (`PLAYER_GROUND_FRICTION_PER_SEC = 0.5` in
        // `movement/common.rs`, vs retail's 0.95) so the accel cap can
        // hold the smoothed velocity within a small percent of the
        // input target at steady state.
        //
        // The Z axis is NOT touched here — `vertical_velocity` is
        // managed separately by the jump/fall arcs (see lines
        // 841-848). We only smooth X/Y.
        //
        // When airborne, the trajectory is LOCKED to the launch velocity —
        // mid-air WASD does NOT re-aim it (no mid-air steering), matching
        // retail. ACE's `MotionInterp.contact_allows_move`
        // (`MotionInterp.cs:584`) returns false for forward/sidestep
        // velocity-bearing motions while there is no Contact, so a new
        // forward/strafe command cannot drive a position delta in the air;
        // the world-space planar velocity stamped at launch
        // (`LeaveGround` / `get_leave_ground_velocity`, `MotionInterp.cs:192`)
        // carries the body through the arc unchanged. The rig FACING can
        // still turn in flight (TurnRight/TurnLeft are exempt from the
        // contact gate) — that is handled by the omega path below, which
        // rotates `pose.rotation` only and never re-derives this frozen
        // world-space velocity.
        let smoothed_planar = if world.player.is_airborne {
            // Airborne — use the frozen launch velocity verbatim. Do NOT
            // recompute from `target_velocity` (that would let new WASD
            // redirect the trajectory mid-air). `current_planar_velocity`
            // is WORLD-FRAME (see `local_velocity_for_state` in
            // `common.rs`, which rotates the magnitudes by heading), so it
            // is applied to position below WITHOUT re-rotating by the
            // in-flight heading.
            world.player.current_planar_velocity
        } else if USE_INTERPRETED_VELOCITY {
            // STAGE 1 (2026-06-11) — retail direct-set, absorbed from the
            // F1-1 `USE_DIRECT_GROUND_VELOCITY` gate. Retail's
            // `apply_raw_movement` sets the motion velocity straight from the
            // interpreted state every tick and on-ground translation is the
            // authored cycle velocity × speed_mod reached INSTANTLY (no
            // friction/accel-cap ramp for self-powered locomotion —
            // `add_motion` acclient.c:337431-337474). `target_velocity`
            // above is the interpreted-pipeline derivation; setting the
            // planar store to it removes the legacy ~11.7 m/s steady-state
            // ceiling (so high-Run characters reach retail's 18 m/s), the
            // 1.5–4 s ice-skating ramp, and the ~5 m stop-skid. The target
            // is already planar; Z stays owned by the jump/fall arc +
            // floor-Z snap below, so we zero it in the store exactly as the
            // friction path did.
            let mut v = target_velocity;
            v.z = 0.0;
            // Retail small-velocity snap (`PhysicsObj` `small_velocity`): when
            // the input is released the interpreted forward command goes to 0,
            // so the target drops below threshold and the body stops THIS tick
            // — an instant stop, matching retail (no skid for self-powered
            // locomotion).
            let mag_sq = v.x * v.x + v.y * v.y;
            let threshold_sq =
                PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC * PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC;
            if mag_sq < threshold_sq {
                v.x = 0.0;
                v.y = 0.0;
            }
            world.player.current_planar_velocity = v;
            v
        } else {
            // Grounded: apply friction decay + accel cap, then snap to
            // zero below the small-velocity threshold.
            let mut v = world.player.current_planar_velocity;

            // Physics deep-dive 2026-06-01 (Dimension 3) — contact-plane
            // projection + SLEDDING overrides, faithful to ACE
            // `PhysicsObj.calc_friction` (`PhysicsObj.cs:2120-2141`).
            //
            // Resolve the contact-plane normal under the feet (retail's
            // `ContactPlane.Normal`). Indoors with baked triangles we use
            // the real floor-triangle normal so the projection strips the
            // into-surface velocity component on a ramp; everywhere else
            // (outdoor heightmap — locally flat per terrain sample — or a
            // not-yet-baked / off-floor cell) we fall back to the flat
            // `(0,0,1)` normal, which makes the projection a no-op (the
            // velocity store is already planar, `v.z == 0`). On flat
            // ground this is identical to the prior scalar decay.
            let contact_normal = if pose.is_indoors() {
                let cell_id = world.scene.current_cell(&pose);
                let triangles = world.scene.cell_triangles(cell_id);
                let global = pose.global_coords();
                let ceiling = world
                    .scene
                    .cell_aabb(cell_id)
                    .map(|a| a.max.z + 1.0)
                    .unwrap_or(pose.coords.z + 100.0);
                holtburger_world::spatial::floor_normal_under(
                    triangles, global.x, global.y, ceiling,
                )
                .unwrap_or(Vector3::new(0.0, 0.0, 1.0))
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            };

            // The coefficient is the contested knob. The projection /
            // SLEDDING fidelity rides along regardless (see
            // `USE_RETAIL_GROUND_FRICTION` — default-OFF means keep `0.5`).
            let friction = if USE_RETAIL_GROUND_FRICTION {
                PLAYER_GROUND_FRICTION_RETAIL
            } else {
                PLAYER_GROUND_FRICTION_PER_SEC
            };

            // SLEDDING gate: retail's `calc_friction` only consults the
            // SLEDDING branches when `State.HasFlag(PhysicsState.Sledding)`
            // (`PhysicsObj.cs:2130`). That is a discrete object state — set
            // for ice/sled physics objects, NOT for a normally-walking
            // player. We don't carry the Sledding state bit on the local
            // player and a walking player is never sledding, so this is
            // `false` (matching retail: the sledding branches are dead for
            // a non-sledding object). The branches are nonetheless fully
            // ported + unit-tested in `calc_friction` so a future
            // sled/ice-physics object can drive them faithfully.
            //
            // Keeping this `false` is also what preserves flat-ground
            // walking exactly: with `normal = (0,0,1)` a geometric-only
            // sledding gate would (wrongly) fire the near-flat high-speed
            // glide on every level-ground run.
            let sledding = false;

            // `velocity_mag2` is the pre-projection magnitude, matching ACE
            // (`UpdatePhysicsInternal` passes `Velocity.LengthSquared()`).
            // The planar store keeps `v.z == 0` so this is the true 3D
            // magnitude on flat ground; on a ramp the small into-surface
            // component the projection then removes is what reduces the
            // horizontal speed.
            let velocity_mag2 = v.x * v.x + v.y * v.y;
            calc_friction(
                &mut v,
                contact_normal,
                velocity_mag2,
                friction,
                sledding,
                dt_s,
            );
            // Our velocity store is planar by contract — Z is owned by the
            // jump/fall arc + floor-Z snap below, not by this lateral
            // smoother. On a sloped contact normal the projection above
            // introduces a vertical component (`v.z = -normal.z * angle`);
            // keep its *horizontal* effect (the reduced `v.x`/`v.y`) and
            // discard the Z so it can't leak into the planar store or the
            // world-space delta. On flat ground `v.z` is already 0.
            v.z = 0.0;

            // Move toward target with per-axis accel cap. Retail has no
            // explicit cap (uses friction-only smoothing); this is a
            // game-feel addition to make direction changes ramp through
            // zero. The user flagged this constant as "tune-later".
            let accel_step = PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ * dt_s;
            for (cur, tgt) in [(&mut v.x, target_velocity.x), (&mut v.y, target_velocity.y)] {
                let delta = tgt - *cur;
                let clamped = delta.clamp(-accel_step, accel_step);
                *cur += clamped;
            }
            // small-velocity snap (PhysicsObj.cpp:589-592).
            let mag_sq = v.x * v.x + v.y * v.y;
            let threshold_sq =
                PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC * PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC;
            // The snap fires only when both the target and the current
            // velocity are below the threshold — otherwise the player
            // is actively accelerating from rest, and snapping would
            // kill the ramp-up. This matches the spirit of retail's
            // gate (`velocity_mag2 < small_velocity^2`): the player
            // has stopped requesting movement, so kill residual drift.
            let target_mag_sq =
                target_velocity.x * target_velocity.x + target_velocity.y * target_velocity.y;
            if mag_sq < threshold_sq && target_mag_sq < threshold_sq {
                v.x = 0.0;
                v.y = 0.0;
            }
            world.player.current_planar_velocity = v;
            v
        };

        // Build the world-space delta. X/Y come from the smoothed
        // velocity; Z still flows from `target_velocity.z` so the
        // existing airborne integrator below can override with the
        // gravity arc when `is_airborne`.
        let raw_delta = Vector3::new(
            smoothed_planar.x * dt_s,
            smoothed_planar.y * dt_s,
            target_velocity.z * dt_s,
        );
        // Lateral (X/Y) clamp. Two paths:
        //   - Outdoor: Phase 6 step B sweep-sphere against the
        //     per-cell `building_aabb_index`. Z stays raw so the
        //     terrain-Z snap below can do its job.
        //   - Indoor:  Phase 6 follow-on (academy rubberband fix,
        //     2026-05-10) — clamp the proposed lateral motion to the
        //     interior of the player's current EnvCell's world-space
        //     AABB (already populated by Phase 6D). Without this the
        //     player walks straight through dungeon walls because
        //     `building_aabb_index` is outdoor-only; the divergence
        //     between the client's predicted pose and ACE's
        //     authoritative cell-bounded pose is what surfaces as
        //     visible rubberbanding. Falls back to no-clamp when the
        //     cell hasn't been baked yet (lazy `fetchEnvCellsInLand-
        //     block` path) or the player has drifted outside every
        //     cell — in the latter case the next server `Update-
        //     Position` will snap them back inside, after which this
        //     clamp engages and keeps them there.
        // Pre-bake gate: indoor cell whose physics_polygons +
        // cell AABB haven't been baked yet. Detected once so the
        // lateral clamp, the Z delta, and the floor-Z snap all
        // agree to leave `pose` exactly where the server seeded
        // it. The first frame after `[phase6.G] drained …` flips
        // this false and full prediction engages.
        // Terrain→EnvCell entry (2026-06-02): retail/ACE write the new
        // ObjCellID CLIENT-LOCALLY on every transition (find_cell_list /
        // check_building_transit, acclient.c:318229/348110) — the server
        // never participates in the entry decision. holtburger previously
        // left `pose.landblock_id` server-authoritative and never
        // re-derived it locally, so a player walking into a cottage — an
        // EnvCell with no outdoor building AABB — passed through the shell
        // until the next server UpdatePosition flipped them indoors (the
        // clip-through window). Mirror retail: when the predicted pose is
        // still outdoor but the capsule has reached a loaded EnvCell hull,
        // flip `landblock_id` to that cell NOW so `is_indoors()` selects
        // the per-poly cell-wall clamp below THIS tick. The server's
        // authoritative id confirms it (identical) or gently corrects it
        // (constrain_local_pose_toward) on the next packet; a hard
        // AuthoritativeBodySync::Reset still overrides. Runs BEFORE
        // `indoor_unbaked` and the `is_indoors()` branch so they all see
        // the flipped pose this tick.
        if USE_LOCAL_ENVCELL_ENTRY
            && !pose.is_indoors()
            && let Some(entered) = world.scene.entered_envcell_for_outdoor_pose(
                &pose,
                holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
            )
        {
            pose.landblock_id = Guid(entered);
        }

        // EnvCell→terrain EXIT (B11, 2026-06-09): the symmetric inverse
        // of the entry flip above. The entry flip latches `is_indoors()`
        // on building entry; without this inverse the
        // `clamp_delta_to_cell_interior` net (below) boxes the player
        // inside the cell AABB forever — they can enter a cottage/mansion
        // but the doorway becomes an invisible wall on the way out.
        // Retail `check_building_transit` re-derives cell membership from
        // geometry every tick in BOTH directions; mirror the exit half so
        // entry and exit are symmetric. Same `USE_LOCAL_ENVCELL_ENTRY`
        // flag (entry/exit MUST move together) and same pre-`indoor_-
        // unbaked` / pre-`is_indoors()` ordering so the whole tick sees
        // the flipped pose. `exited_envcell_to_outdoor` self-guards
        // against unbaked indoor geometry (returns None) so a half-loaded
        // cell never ejects the player mid-room; the AABB-net relaxation
        // in the indoor branch below is what actually lets the capsule
        // reach the doorway so this flip can fire next tick.
        if USE_LOCAL_ENVCELL_ENTRY
            && pose.is_indoors()
            && let Some(outdoor) = world
                .scene
                .exited_envcell_to_outdoor(&pose, holtburger_world::spatial::PLAYER_CAPSULE_RADIUS)
        {
            pose.landblock_id = Guid(outdoor);
        }

        let indoor_unbaked = if pose.is_indoors() {
            let cell_id = world.scene.current_cell(&pose);
            world.scene.cell_triangles(cell_id).is_empty()
                && world.scene.cell_aabb(cell_id).is_none()
        } else {
            false
        };
        let lateral = Vector3::new(raw_delta.x, raw_delta.y, 0.0);
        // Physics deep-dive 2026-06-01 (gap 3 follow-up: edge_slide).
        // The indoor per-poly wall clamp also surfaces the XY contact-
        // plane normal of the earliest wall it hit (or `None`). The
        // step-up-refused branch below consults it to slide the blocked
        // residual along the wall tangent instead of stopping dead. The
        // outdoor building clamp does not expose a normal yet, so
        // edge_slide is indoor-only this pass (the common case — risers
        // taller than the step-up height live in dungeons / buildings).
        let mut cell_wall_normal: Option<Vector3> = None;
        let lateral_clamped = if pose.is_indoors() {
            // 2026-05-10 indoor collision: prefer per-polygon
            // wall-clamp against the cell's `physics_polygons`
            // (Phase 6 step G) when triangles are loaded; fall back
            // to the cell-AABB containment clamp when they aren't.
            // The per-poly clamp handles non-rectangular cells
            // (L-shapes, corridors with bends, doorways) accurately;
            // the AABB clamp is the safety net while the lazy
            // physics-bake catches up after a landblock entry.
            //
            // Pre-bake gate (academy rubberband fix follow-on
            // 2026-05-10): when neither the cell AABB nor any
            // physics triangles have been loaded yet — typical for
            // the first few seconds after entity seed before
            // `fetchEnvCellsInLandblock` finishes its async bake —
            // refuse to predict any indoor motion. Without this,
            // the integrator runs unclamped, the heartbeat ships
            // positions ACE rejects, and the resulting force-
            // reposition snaps the player back to spawn (the
            // "moves a little, snaps back" symptom). With this
            // gate, the heartbeat keeps repeating the last server-
            // confirmed pose until the bake completes; rotation
            // flow is unaffected since rotation flows through
            // `UpdateMotion` (server-driven), not this integrator.
            let cell_id = world.scene.current_cell(&pose);
            let triangles = world.scene.cell_triangles(cell_id);
            let cell_aabb_opt = world.scene.cell_aabb(cell_id);
            // PR-RR 2026-05-23: open-door exclusion list — cell-mesh
            // sweeps skip triangles whose centroid sits inside any of
            // these. Lets the player walk through doors whose collision
            // panel is part of the EnvCell BSP (the common indoor
            // case). Empty when no doors are open near the player; the
            // sweep no-ops on empty exclusion via the existing
            // `exclusion_aabbs.is_empty()` short-circuit.
            let exclusion_aabbs = world.scene.open_door_exclusion_aabbs_near(&pose);
            if triangles.is_empty() && cell_aabb_opt.is_none() {
                Vector3::zero()
            } else {
                let pre_clamped = if !triangles.is_empty() {
                    // CalcNumSteps substepping (2026-06-01): route the
                    // cell-wall sweep through the flag-gated dispatch.
                    // With `USE_SUBSTEP_TRANSITION` OFF (DEFAULT) the
                    // dispatch takes the single-pass `_with_normal`
                    // branch, so the shipped solver behaviour is
                    // bit-for-bit unchanged; ON it subdivides a fast
                    // lateral move into `ceil(dist/radius)` collide+slide
                    // sub-segments (retail non-viewer
                    // `Transition.CalcNumSteps`) so fast motion can't
                    // tunnel a thin wall and a diagonal into an L-corner
                    // engages a wall the single pass misses. Either way
                    // it returns the same `(clamped, normal)` shape.
                    let (clamped, normal) =
                        holtburger_world::spatial::clamp_delta_against_cell_walls_dispatch(
                            triangles,
                            &pose,
                            lateral,
                            holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                            holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT,
                            &exclusion_aabbs,
                        );
                    // Surface the wall normal for the edge_slide path.
                    // Under substepping this is the LAST sub-segment's
                    // wall normal (the `LastKnownContactPlane` hook for
                    // the deferred cliff_slide cross-product — see the
                    // TODO in `clamp_delta_against_cell_walls_substepped`).
                    cell_wall_normal = normal;
                    clamped
                } else {
                    lateral
                };
                // Always also apply the AABB containment clamp as a
                // safety net — even with per-poly walls, an L-shaped
                // cell whose wall triangles are missing on one segment
                // could let the player drift out of the AABB. Cheap
                // and idempotent on top of per-poly.
                //
                // PR-RR.1 2026-05-23: bypass the safety net when an
                // open door is within range — the cell AABB stops at
                // the doorway, so containment clamp crops the player's
                // delta right at the door even with the panel polys
                // already excluded. Per-poly walls + door-entity
                // ETHEREAL filter are sufficient inside the doorway
                // (any nearby wall triangle would have caught us in
                // the prior pass). Trade-off: temporarily disables the
                // L-shaped-cell drift defence when standing next to
                // an open door — acceptable for the door-walk-through
                // UX. Proper fix is a multi-cell containment variant
                // that consults the portal graph (see
                // docs/FOLLOW_ONS.md "Cell-AABB containment vs.
                // doorway crossing").
                // B11 doorway relaxation (2026-06-09): also bypass the
                // cell-AABB containment net for a building's ground-floor
                // EXIT room (a cell with an outdoor-exit portal) once its
                // per-poly walls are loaded. The cell AABB stops at the
                // doorway, so the net would crop the player's exit delta
                // right at the door — boxing them in even though the per-
                // poly walls already model the opening. Without this the
                // capsule centre can never leave the AABB, so the EXIT
                // flip above never trips and you can enter a house but
                // never walk back out. Scoped tight on purpose: ONLY
                // outdoor-exit cells (interior dungeon cells keep the net
                // — they have no door to the terrain) and ONLY when
                // `triangles` are present (real walls to fall back on, so
                // we don't trade the doorway gap for unclamped drift).
                // Tied to the same `USE_LOCAL_ENVCELL_ENTRY` flag as the
                // entry/exit flips so the whole transition feature toggles
                // as a unit.
                // 2026-06-15 — extended the B11 relaxation from outdoor-exit
                // rooms to INTERIOR room-to-room doorways. The per-cell AABB
                // net stops at the current room's AABB face, which sits across
                // an interior doorway, so it crops the player's delta there =
                // the room-to-room invisible wall (e.g. Holtburg cottage cell
                // 0xA9B40101, interior portals only). `at_interior_doorway`
                // gates on a LOADED neighbour AABB within a capsule radius so a
                // `visible_cells` PVS edge can't over-relax (wall-through). The
                // `!triangles.is_empty()` guard keeps the per-poly walls as the
                // backstop, so we never trade the doorway gap for unclamped drift.
                let doorway_relax = USE_LOCAL_ENVCELL_ENTRY
                    && !triangles.is_empty()
                    && (world.scene.cell_has_outdoor_exit(cell_id)
                        || world.scene.at_interior_doorway(
                            &pose,
                            cell_id,
                            holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                        ));
                match cell_aabb_opt {
                    Some(aabb) if exclusion_aabbs.is_empty() && !doorway_relax => {
                        holtburger_world::spatial::clamp_delta_to_cell_interior(
                            &pose,
                            pre_clamped,
                            &aabb,
                            holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                        )
                    }
                    _ => pre_clamped,
                }
            }
        } else {
            let candidates = world.scene.building_aabbs_near_pose(&pose);
            if candidates.is_empty() {
                lateral
            } else if USE_OUTDOOR_WALL_NORMALS {
                let (clamped, normal) =
                    holtburger_world::spatial::clamp_delta_against_buildings_with_normal(
                        &candidates,
                        &pose,
                        lateral,
                        holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                    );
                // Surface the wall normal for the edge_slide / cliff_slide
                // stages, mirroring the indoor polygon-clamp path above.
                cell_wall_normal = normal;
                clamped
            } else {
                holtburger_world::spatial::clamp_delta_against_buildings(
                    &candidates,
                    &pose,
                    lateral,
                    holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                )
            }
        };
        // BSP collision PASS 1 (2026-06-02, DATA LA) — DEFAULT-OFF.
        // Use the faithful physics-BSP `sphere_intersects_solid` walk as
        // the AUTHORITATIVE "is the requested target solid" test,
        // replacing the flat-triangle-bag verdict for the static
        // blocking case. The flat-tri `lateral_clamped` above already
        // carries the slide/back-off the integrator falls back to when
        // the target IS solid; here we only OVERRIDE it to the full
        // requested move when the BSP confirms the un-clamped target is
        // clear (the triangle bag was over-clamping a passable opening,
        // e.g. a doorway whose panel triangles cross the swept circle).
        // Indoor-only (the BSP is per-EnvCell); a cell with no parsed
        // BSP no-ops and the flat-tri result stands. See `USE_PHYSICS_BSP`.
        let lateral_clamped = if USE_PHYSICS_BSP
            && pose.is_indoors()
            && !indoor_unbaked
            && lateral.length_squared() > 1e-10
        {
            let cell_id = world.scene.current_cell(&pose);
            if world.scene.cell_physics_bsp(cell_id).is_some() {
                // Probe the player capsule at the FULLY-REQUESTED
                // (un-clamped) end pose with the low+high two-sphere
                // cylinder. `feet_world_z` is the bottom of the capsule
                // at the current Z (the lateral move doesn't change Z).
                let global = pose.global_coords();
                let target_xy = (global.x + lateral.x, global.y + lateral.y);
                let feet_world_z = global.z;
                let target_solid = world.scene.cell_physics_bsp_solid(
                    cell_id,
                    target_xy,
                    feet_world_z,
                    holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                    holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT,
                );
                if target_solid {
                    // BSP confirms a wall at the target — keep the
                    // flat-tri slide/back-off (the working solver owns
                    // the resolution; PASS 1 does not reimplement the
                    // retail Transition slide state machine).
                    lateral_clamped
                } else {
                    // BSP says the target is clear — take the full
                    // requested move (the triangle bag over-clamped).
                    cell_wall_normal = None;
                    lateral
                }
            } else {
                lateral_clamped
            }
        } else {
            lateral_clamped
        };
        // Track B4 outdoor-static collision (Tier 1, AABB-only,
        // 2026-06-08): clamp the (building/indoor-clamped) lateral
        // delta against the outdoor non-building statics near the
        // player (trees, signs, props from `LandblockInfo.objects`,
        // the `Stab` list with `is_building == false`). These get NO
        // player collision in the shipped solver — the indoor/building
        // passes above only cover EnvCell mesh + building AABBs, and
        // the statics-AABB index had no live consumer here (only the
        // camera sweep read it). ACE's `PhysicsObj.FindObjCollisions`
        // tests the mover against every nearby `PhysicsState::Static`
        // object via its physics geometry; Tier-1 approximates that
        // with a coarse stop-and-slide against each static's world-
        // space AABB. Mirrors `clamp_delta_against_buildings_with_-
        // normal`'s math (swept-sphere clamp + one slide iteration)
        // but inlined here because the per-static-AABB clamp has no
        // wall-normal consumer (statics don't feed edge/cliff-slide).
        //
        // Tier-2 (per-static physics-BSP, the faithful FindObjCollisions
        // polygon test) and the swept `BSPTree.find_collisions` port are
        // a deferred follow-on; this pass is AABB-only.
        let lateral_clamped = if lateral_clamped.length_squared() <= 1e-10 {
            lateral_clamped
        } else {
            // Broad-phase: the scene query already restricts to the
            // pose's landblock + the immediate 3x3 neighbour ring, and
            // outdoor statics fan-in is small (Holtburg's central LB
            // has ~70). Empty candidate sets early-out before any
            // swept-sphere math, so dense LBs stay cheap.
            let mut candidates = world.scene.statics_aabbs_near_pose(&pose);
            // B4 Tier-2 (2026-06-09): when the static-BSP gate is on, cede
            // statics that carry a precise BSP from this coarse-AABB sweep
            // — the BSP push-out below handles them so the capsule can
            // approach the true surface instead of stopping at the 8-corner
            // bound. BSP-less statics keep the AABB clamp. When the gate is
            // off this is a no-op (every entry has `has_bsp == false`), so
            // Tier-1 stays byte-identical.
            if USE_STATIC_BSP {
                candidates.retain(|c| !c.has_bsp);
            }
            if candidates.is_empty() {
                lateral_clamped
            } else {
                let radius = holtburger_world::spatial::PLAYER_CAPSULE_RADIUS;
                match holtburger_world::spatial::sweep_sphere_against_static_aabbs(
                    &candidates,
                    &pose,
                    lateral_clamped,
                    radius,
                ) {
                    None => lateral_clamped,
                    Some(hit) => {
                        // Stop short of the static (back off a hair so
                        // the capsule never rests exactly on the face),
                        // then attempt a single slide along the hit
                        // plane against the same candidate set. Same
                        // shape as the building clamp's slide pass.
                        let delta = lateral_clamped;
                        let backoff = 1e-3;
                        let safe_t = (hit.t - backoff / delta.length().max(1e-6)).max(0.0);
                        let stopped_delta = delta * safe_t;
                        let remaining = delta * (1.0 - safe_t);
                        let into_normal = remaining.dot(&hit.normal);
                        let slide = remaining - hit.normal * into_normal;
                        if slide.length_squared() <= 1e-10 {
                            stopped_delta
                        } else {
                            let slide_pose = holtburger_common::position::WorldPosition {
                                landblock_id: pose.landblock_id,
                                coords: Vector3::new(
                                    pose.coords.x + stopped_delta.x,
                                    pose.coords.y + stopped_delta.y,
                                    pose.coords.z + stopped_delta.z,
                                ),
                                rotation: pose.rotation,
                            };
                            let slide_clamped =
                                match holtburger_world::spatial::sweep_sphere_against_static_aabbs(
                                    &candidates,
                                    &slide_pose,
                                    slide,
                                    radius,
                                ) {
                                    Some(slide_hit) => {
                                        slide
                                            * (slide_hit.t - backoff / slide.length().max(1e-6))
                                                .max(0.0)
                                    }
                                    None => slide,
                                };
                            stopped_delta + slide_clamped
                        }
                    }
                }
            }
        };
        // B4 Tier-2 (2026-06-09): per-static physics-BSP push-out. After
        // the coarse-AABB sweep (which, under USE_STATIC_BSP, now covers
        // only BSP-less statics), resolve the capsule OUT of any precise
        // static BSP it penetrates at the post-clamp target. Push-out only
        // — fine for walking-speed locomotion (per-tick step ≪ trunk
        // radius); the swept stop is the deferred follow-on. Lateral push
        // only: the Z displacement is dropped so the downstream floor-Z
        // snap stays the sole vertical authority. No-op when the gate is
        // off or no static BSP is near (`resolve_static_bsp_pushout` →
        // None), so Tier-1 behaviour is preserved.
        let lateral_clamped = if USE_STATIC_BSP {
            let global = pose.global_coords();
            let tx = global.x + lateral_clamped.x;
            let ty = global.y + lateral_clamped.y;
            let tz = global.z;
            let r = holtburger_world::spatial::PLAYER_CAPSULE_RADIUS;
            let h = holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT;
            // ACE two-sphere cylinder: low at feet+radius, high at head−radius.
            let low = Vector3::new(tx, ty, tz + r);
            let high = Vector3::new(tx, ty, tz + (h - r).max(r));
            match world
                .scene
                .resolve_static_bsp_pushout(&pose, &[low, high], r, 2)
            {
                Some(disp) => Vector3::new(
                    lateral_clamped.x + disp.x,
                    lateral_clamped.y + disp.y,
                    lateral_clamped.z,
                ),
                None => lateral_clamped,
            }
        } else {
            lateral_clamped
        };
        // Entity collision pass. Mirrors ACE's
        // `PhysicsObj.find_object_collisions`
        // (`Source/ACE.Server/Physics/PhysicsObj.cs:~410`), which
        // tests the moving object against every nearby world object
        // and branches on `PhysicsState::HAS_PHYSICS_BSP` to pick
        // BSP-polygon vs cylsphere collision. We only do the
        // cylsphere fallback today; the BSP path is wired through
        // `EntityCollider::has_physics_bsp` and is a follow-on.
        //
        // Filtering rules (caller-side, before reaching the math):
        //   - Skip the local player itself.
        //   - Skip `!Entity::is_collidable()` (entities with
        //     `ETHEREAL` like open doors, or `IGNORE_COLLISIONS`).
        //   - Spatial pre-filter: only consider entities within
        //     `lateral.length() + (combined radii)` so we don't pay
        //     the swept-circle math for entities we can't possibly
        //     reach this tick.
        //
        // Per-entity radius: looked up from the SetupModel
        // cyl-sphere cache (`WorldState::setup_radii`, populated
        // wasm-side by the SetupModel loader). Misses fall back to
        // the player capsule radius — a reasonable default for
        // humanoid-scale entities whose SetupModel hasn't been
        // loaded yet. Mirrors ACE's `PhysicsObj.GetPhysicsRadius` at
        // `Source/ACE.Server/Physics/PhysicsObj.cs:~590`.
        // A7-R6 (2026-06-12): resolve deferred ethereal expiries — an
        // entity whose solidify was deferred while the player overlapped
        // it (apply_set_state_update, retail set_ethereal(0) defer)
        // solidifies the moment the player steps clear, mirroring
        // retail's transient-0x100 per-frame re-check
        // (acclient.c:317832-317866). Runs against the LOCAL working
        // pose (the freshest player position). Flag off: no entity ever
        // has the pending bit, so this is a no-op scan.
        if holtburger_world::entity::USE_ETHEREAL_RECHECK {
            let player_global = pose.global_coords();
            let pending: Vec<_> = world
                .entities
                .iter()
                .filter(|e| e.ethereal_recheck_pending)
                .map(|e| {
                    let g = e.position.global_coords();
                    (e.guid, (g.x, g.y), world.entity_collision_radius(e))
                })
                .collect();
            for (guid, center, radius) in pending {
                let overlapping = holtburger_world::spatial::spheres_overlap_xy(
                    (player_global.x, player_global.y),
                    holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                    center,
                    radius,
                );
                if let Some(entity) = world.entities.get_mut(guid) {
                    entity.resolve_ethereal_recheck(overlapping);
                }
            }
        }
        let lateral_clamped = {
            let self_guid = world.player.guid;
            let player_global = pose.global_coords();
            let player_radius = holtburger_world::spatial::PLAYER_CAPSULE_RADIUS;
            // Conservative pre-filter radius — assume the largest
            // reasonable entity is ~2m wide (a small giant) so we
            // don't miss large creatures. Tighter pre-filter would
            // need to inspect each entity's resolved radius first,
            // which is the work we're trying to avoid for far-away
            // candidates.
            let prefilter_dist = lateral_clamped.length() + player_radius + 2.0;
            let prefilter_sq = prefilter_dist * prefilter_dist;
            let colliders: Vec<_> = world
                .entities
                .iter()
                .filter(|e| {
                    e.guid != self_guid
                        && e.is_collidable()
                        && !(SKIP_PARENTED_ENTITY_COLLISION && e.physics_parent_id.is_some())
                })
                .filter_map(|e| {
                    let g = e.position.global_coords();
                    let dx = g.x - player_global.x;
                    let dy = g.y - player_global.y;
                    if dx * dx + dy * dy >= prefilter_sq {
                        return None;
                    }
                    Some(holtburger_world::spatial::EntityCollider {
                        center_xy: (g.x, g.y),
                        radius: world.entity_collision_radius(e),
                        has_physics_bsp: e.has_physics_bsp(),
                    })
                })
                .collect();
            if colliders.is_empty() {
                lateral_clamped
            } else {
                holtburger_world::spatial::clamp_delta_against_entities(
                    &colliders,
                    &pose,
                    lateral_clamped,
                    player_radius,
                )
            }
        };
        // Physics deep-dive 2026-06-01 (gap 3) — step-UP. When the
        // lateral clamp shortened the requested move (a wall/riser
        // blocked us) and we're grounded, probe the floor at the
        // *intended* (un-clamped) destination. If a walkable floor
        // sits there within `PLAYER_STEP_UP_HEIGHT` of the feet, climb
        // onto it (raise Z) and take the full lateral move instead of
        // stopping dead — retail's `Transition.StepUp`
        // (`Transition.cs:746-777`, capped at `ObjectInfo.StepUpHeight`).
        // Risers taller than the step-up height stay blocked.
        //
        // Skipped while airborne (climbing is a ground action; the
        // jump/fall arc owns Z), while the indoor cell is unbaked (no
        // floor source), and when the gate is off.
        if USE_STEP_UP_DOWN
            && !world.player.is_airborne
            && !indoor_unbaked
            && lateral.length_squared() > 1e-10
        {
            // "Blocked": the clamp removed a meaningful slice of the
            // requested lateral travel. A tiny shortfall is just the
            // slide/backoff jitter, not a wall, so require a clear gap
            // (10% of the requested length, floor 1 cm) before we
            // treat it as a step-up candidate.
            let requested_len = lateral.length();
            let clamped_len = lateral_clamped.length();
            let blocked_gap = requested_len - clamped_len;
            let blocked = blocked_gap > (requested_len * 0.1).max(0.01);
            if blocked {
                // Intended (un-clamped) destination pose for the floor
                // probe — where the player WANTED to be this tick.
                let intended = holtburger_common::position::WorldPosition {
                    landblock_id: pose.landblock_id,
                    coords: Vector3::new(
                        // `pose.coords` is still THIS tick's start position
                        // here (lateral_clamped/lateral are only applied to
                        // it below), so the un-clamped intended destination
                        // is start + the full requested lateral move. The
                        // earlier `- lateral_clamped` terms wrongly probed
                        // start + the *blocked* portion instead.
                        pose.coords.x + lateral.x,
                        pose.coords.y + lateral.y,
                        pose.coords.z,
                    ),
                    rotation: pose.rotation,
                };
                let dest_global = intended.global_coords();
                let feet_z = pose.coords.z;
                // Floor at the intended destination, indoor vs outdoor.
                let dest_floor_z: Option<f32> = if intended.is_indoors() {
                    let cell_id = world.scene.current_cell(&intended);
                    let triangles = world.scene.cell_triangles(cell_id);
                    let cell_aabb = world.scene.cell_aabb(cell_id);
                    // Cap the floor query a step-up above the feet so a
                    // distant high floor (e.g. an upper landing reached
                    // by a separate ramp) doesn't masquerade as a step.
                    let ceiling = feet_z + player_step_up_height(world);
                    if !triangles.is_empty() {
                        holtburger_world::spatial::highest_floor_z_under(
                            triangles,
                            dest_global.x,
                            dest_global.y,
                            ceiling,
                        )
                    } else {
                        // No triangles yet — the AABB floor is the only
                        // source, and it's flat, so there's no riser to
                        // step onto. Leave step-up to the per-poly path.
                        let _ = cell_aabb;
                        None
                    }
                } else {
                    world.terrain_height_at(dest_global.x, dest_global.y)
                };
                if let Some(new_feet_z) = holtburger_world::spatial::step_up_decision(
                    blocked,
                    feet_z,
                    dest_floor_z,
                    player_step_up_height(world),
                ) {
                    // Climb: take the full intended lateral move and
                    // raise the feet onto the riser top. The floor-Z
                    // snap below keeps us seated once we're up there.
                    pose.coords.x = intended.coords.x;
                    pose.coords.y = intended.coords.y;
                    pose.coords.z = new_feet_z;
                } else {
                    // Step-up REFUSED (riser too tall). edge_slide
                    // Stage-1: instead of stopping dead at the clamped
                    // delta, slide the blocked residual along the wall
                    // tangent — gated on the player's `AllowEdgeSlide`
                    // flag and the availability of the wall normal the
                    // clamp surfaced. Mirrors retail
                    // `SpherePath.StepUpSlide` → `Sphere.SlideSphere`
                    // no-contact-plane branch (removes the into-wall
                    // component). See [`USE_EDGE_SLIDE`].
                    let slid = edge_slide_refused_step_up(
                        lateral,
                        lateral_clamped,
                        cell_wall_normal,
                        // Cliff_slide Stage-2 `N_last` (DEFAULT-OFF behind
                        // `USE_CLIFF_SLIDE`): the wall normal carried from
                        // the PRIOR slice. The InitLastKnownContactPlane
                        // equivalent below stamps this slice's `N_new`
                        // into the carrier AFTER this consume, so the
                        // NEXT slice sees the current wall as its
                        // `N_last`.
                        world.player.last_known_wall_normal,
                        world.player.allow_edge_slide,
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
        // Cliff_slide Stage-2 — InitLastKnownContactPlane equivalent
        // (retail `Transition.InitLastKnownContactPlane` /
        // `acclient.c:312005`). The lateral clamp + edge_slide path above
        // has finished CONSUMING this slice's `N_last`
        // (`world.player.last_known_wall_normal` as it was on entry), so
        // now stamp THIS slice's surfaced wall normal `N_new`
        // (`cell_wall_normal`) into the carrier — the NEXT slice will see
        // the current wall as its `N_last` and can cross it with its own
        // new wall for the seam-skid. Only updated when a wall was
        // actually hit this slice (`cell_wall_normal == Some`); a slice
        // with no wall leaves the prior tracked plane intact so a brief
        // gap between two wall segments still wedges correctly. The
        // carrier is invalidated to `None` on touchdown
        // (`PlayerState::land`) and on any server reposition
        // (`update_player_position`). This stamp runs regardless of
        // `USE_CLIFF_SLIDE` (cheap, keeps the carrier valid for when the
        // flag flips on); the carrier is only READ inside
        // `edge_slide_refused_step_up` under the flag.
        if let Some(n_new) = cell_wall_normal {
            world.player.last_known_wall_normal = Some(n_new);
        }
        // TODO (physics deep-dive 2026-06-01, gap 3 follow-up):
        // edge_slide / cliff_slide — STATUS.
        //
        // Stage-1 SHIPPED (gated behind [`USE_EDGE_SLIDE`], default-on):
        // when an indoor step-up is REFUSED (riser too tall) the blocked
        // residual is slid along the wall tangent via
        // [`edge_slide_refused_step_up`] instead of stopping dead,
        // consulting the hydrated `AllowEdgeSlide` flag
        // (`PlayerState::allow_edge_slide`, from
        // `PhysicsState::EDGE_SLIDE` / `object.rs:78`). This is the
        // single-plane case of retail's `Transition.EdgeSlide` →
        // `SpherePath.StepUpSlide` → `Sphere.SlideSphere`
        // (`Physics/{Transition,SpherePath,Sphere}.cs`), whose
        // no-contact-plane branch removes the into-wall component
        // exactly as our wall clamp's own single-iteration slide does.
        //
        // Stage-2 cliff_slide cross-product skid SHIPPED (gated behind
        // [`USE_CLIFF_SLIDE`], DEFAULT-OFF):
        //   - The retail `cliff_slide` cross-product skid
        //     (`N_new × N_last`, `Transition.CliffSlide`
        //     `Physics/Transition.cs:242-266`) that slides along the
        //     seam where two non-coplanar walls meet is implemented in
        //     [`holtburger_world::spatial::cliff_slide_residual_along_seam`]
        //     and wired into [`edge_slide_refused_step_up`]. It needs a
        //     SECOND `last_known_contact_plane`, which this solver now
        //     carries across integration slices via
        //     `world.player.last_known_wall_normal` (stamped just above —
        //     the InitLastKnownContactPlane equivalent — and invalidated
        //     on touchdown / server reposition). With the flag OFF the
        //     Stage-1 single-plane slide is unchanged; with it ON a
        //     refused step-up against a fresh wall, while a prior
        //     non-coplanar wall is still tracked, rides the seam instead
        //     of stopping at the first wall.
        //
        // Stage-2 STILL DEFERRED (needs the full CTransition substep
        // backup-pose machinery — explicitly NOT part of this Stage-2):
        //   - The walkable-edge `precipice_slide` + `step_down` re-entry
        //     and `save/restore_check_pos` backup-pose machinery
        //     (`Transition.EdgeSlide` walkable branch,
        //     `Physics/Transition.cs:282-319`). Faking these in the
        //     single-pass solver would diverge from ACE's server
        //     reconciliation and risk the indoor-rubberband class the
        //     pre-bake gate guards against — so the outdoor walk-off a
        //     non-walkable cliff edge still uses the abrupt
        //     LEDGE_FALL_THRESHOLD_M / step-down path below.
        //
        // The outdoor building clamp does not expose a wall normal yet,
        // so both Stage-1 edge_slide AND Stage-2 cliff_slide are
        // indoor-only this pass.
        //
        // Pre-bake gate: zero Z delta when the indoor cell is
        // unbaked, same rationale as the lateral zero above —
        // sending an uncorrected Z drift would let ACE force-
        // reposition us back to spawn.
        //
        // Airborne integration. When `world.player.is_airborne`,
        // the player is in mid-jump or mid-fall: integrate gravity
        // into the vertical velocity and add the displacement to
        // pose.z. Mirrors ACE's airborne `UpdatePhysicsInternal`.
        // While airborne the per-tick floor snap below treats the
        // floor as a *landing trigger* rather than a clamp, so the
        // jump arc plays out cleanly.
        //
        // Physics deep-dive 2026-06-01 (gap 7): 2nd-order integration.
        // Gravity is carried as an acceleration (`az = -9.8`,
        // consistent with ACE `calc_acceleration` setting
        // `Acceleration.z = -9.8` under the GRAVITY state flag,
        // `PhysicsObj.cs:2079-2080`). The position uses the OLD
        // velocity plus the half-step `0.5 * az * q^2`, THEN the
        // velocity is updated by `az * q` — matching ACE's
        // `movement = Acceleration*0.5*q*q + Velocity*q;
        // Velocity += Acceleration*q` (`PhysicsObj.cs:1854-1858`).
        // This restores the missing `0.5*a*t^2` term the old
        // first-order symplectic-Euler step dropped.
        //
        // `9.8 m/s²` matches ACE's `MovementSystem.GetJumpHeight`
        // kinematic (`v = sqrt(h * 19.6)` ⇒ `g = 9.8`).
        if !indoor_unbaked {
            if world.player.is_airborne {
                // Acceleration-carried gravity (downward).
                let az = -9.8_f32;
                let v_old = world.player.vertical_velocity;
                // Position from OLD velocity + half-step.
                pose.coords.z += v_old * dt_s + 0.5 * az * dt_s * dt_s;
                // Then advance velocity by a*q.
                let v_new = v_old + az * dt_s;
                // Terminal-velocity clamp (gap 1 / gap 7): bound the
                // total velocity magnitude to MAX_VELOCITY so a long
                // fall does not accelerate unbounded. Mirrors ACE's
                // per-quantum clamp inside `UpdatePhysicsInternal`
                // (`Velocity = Normalize(Velocity) * MaxVelocity`,
                // `PhysicsObj.cs:1843-1846`). Retail clamps the WHOLE
                // velocity vector, so we scale the airborne planar
                // store and the vertical velocity by the same factor
                // — keeping the resulting magnitude exactly
                // MAX_VELOCITY and the direction unchanged.
                let mut vx = world.player.current_planar_velocity.x;
                let mut vy = world.player.current_planar_velocity.y;
                let mut vz = v_new;
                let speed_sq = vx * vx + vy * vy + vz * vz;
                if speed_sq > MAX_VELOCITY * MAX_VELOCITY {
                    let scale = MAX_VELOCITY / speed_sq.sqrt();
                    vx *= scale;
                    vy *= scale;
                    vz *= scale;
                    world.player.current_planar_velocity.x = vx;
                    world.player.current_planar_velocity.y = vy;
                }
                world.player.vertical_velocity = vz;
                // Fell-through-world failsafe (2026-07-01). A cell-transit
                // bug can leave the mover airborne with a STALE indoor cell
                // id (the Holtburg building walk-out catapult): with
                // `pose.is_indoors()` stuck true, neither the indoor
                // cell-AABB snap nor the outdoor terrain landing arm below
                // ever engages, so the fall never ends — and the cascade is
                // unrecoverable in-game because ACE refuses every teleport
                // while the client reports airborne ("You're in the air!").
                // After a freefall longer than any legitimate drop (~4 s
                // worst case in retail; we require 6 s) AND a depth well
                // below the outdoor terrain at the mover's global XY,
                // re-seat the pose on the terrain floor: clear the stale
                // indoor cell to the outdoor bucket, rebucket across
                // landblock bounds, snap z, and land().
                const FELL_THROUGH_MIN_AIRBORNE_SECS: f32 = 6.0;
                const FELL_THROUGH_TERRAIN_MARGIN: f32 = 50.0;
                world.player.airborne_secs += dt_s;
                if world.player.airborne_secs >= FELL_THROUGH_MIN_AIRBORNE_SECS {
                    let global = pose.global_coords();
                    if let Some(tz) = world.terrain_height_at(global.x, global.y) {
                        if pose.coords.z < tz - FELL_THROUGH_TERRAIN_MARGIN {
                            log::warn!(
                                "[fell-through-failsafe] airborne {:.1}s at z={:.1} (terrain {:.1}) cell 0x{:08X} — re-seating on terrain",
                                world.player.airborne_secs,
                                pose.coords.z,
                                tz,
                                pose.landblock_id.0,
                            );
                            pose.landblock_id =
                                Guid((pose.landblock_id.0 & 0xFFFF_0000) | 0x0001);
                            pose.coords.z = tz + 0.005;
                            pose = pose
                                .rebucket_outdoor_landblock()
                                .normalize_outdoor_cell();
                            world.player.land();
                        }
                    }
                }
            } else {
                pose.coords.z += raw_delta.z;
                world.player.airborne_secs = 0.0;
            }
        }
        // Floor-Z snap. Two paths:
        //   - Outdoor: bilinear-interp the cached 9×9 terrain
        //     heightmap. Without this the integrator's Z stays at the
        //     teleport-landing value (vz==0 for forward locomotion),
        //     ACE's FastTick (Player_Tick.cs:154 `IsPKType` gate)
        //     reads the client as floating above ground, applies
        //     gravity → fall damage on landing.
        //   - Indoor:  Phase 6 follow-on — snap to `cell_aabb.min.z`
        //     plus a 5 mm headroom (matches the AC convention; ACE
        //     log shows persisted indoor positions at z=0.005). Also
        //     clamp from above so a long jump doesn't punch through
        //     the cell ceiling. This is a coarser proxy than a
        //     swept-triangle test against `physics_polygons` — for a
        //     ramped floor the player visually pops to the cell's
        //     lowest point, but it's enough to stop the rubberband.
        //
        // The outdoor heightmap cache is pre-populated for the 9-LB
        // spawn neighbourhood at `kind=7 EnteredWorld` (see
        // `SessionHandle::populate_terrain`). When it misses
        // (player wandered past the prefetched window) we preserve
        // the existing Z; ACE will apply false gravity in that
        // narrow band but the typical play loop hits the fast path.
        if !pose.is_indoors() {
            let global = pose.global_coords();
            if let Some(z) = world.terrain_height_at(global.x, global.y) {
                // G-8 / F4-4 follow-on (2026-06-11) — wading-depth contact-
                // plane raise, same USE_WATER_COLLISION gate. ACE's
                // `ObjectInfo.ValidateWalkable` adds `waterDepth` to the
                // contact-plane distance (LandCell.find_env_collisions →
                // get_water_depth), so a 1-3-corner shoreline cell carries a
                // raised floor (nearest vertex water ⇒ +0.45, else +0.1) and
                // the walker WADES instead of strolling along the lakebed.
                // EntirelyWater stays hard-blocked by the arm below (+0.9
                // only matters for the airborne landing plane). `0.0` for dry
                // cells / uncached water grids ⇒ byte-identical default.
                let z = if USE_WATER_COLLISION {
                    z + world.water_depth_at(global.x, global.y)
                } else {
                    z
                };
                if world.player.is_airborne {
                    // Airborne outdoor: snap only on landing (falling
                    // through the terrain plane). The terrain Z is the
                    // canonical floor — when ballistic integration
                    // takes us below it with downward velocity, that's
                    // the touchdown.
                    if world.player.vertical_velocity <= 0.0 && pose.coords.z <= z {
                        // A7-R3: landing allowance — refuse near-vertical
                        // perches (N.z < LANDING_Z), keep falling and slide
                        // the slice's lateral along the face tangent.
                        let landing_normal = if USE_LANDING_WALKABLE {
                            world.terrain_normal_at(global.x, global.y)
                        } else {
                            None
                        };
                        if USE_LANDING_WALKABLE
                            && !holtburger_world::spatial::landing_allows_touchdown(
                                landing_normal.map(|n| n.z),
                                holtburger_world::spatial::collision::physics_globals::LANDING_Z,
                            )
                        {
                            if let Some(normal) = landing_normal {
                                let lateral = Vector3 {
                                    x: pose.coords.x - entry_local_xy.0,
                                    y: pose.coords.y - entry_local_xy.1,
                                    z: 0.0,
                                };
                                let slid =
                                    holtburger_world::spatial::slide_residual_along_wall_tangent(
                                        lateral, normal,
                                    );
                                pose.coords.x = entry_local_xy.0 + slid.x;
                                pose.coords.y = entry_local_xy.1 + slid.y;
                            }
                        } else {
                            pose.coords.z = z;
                            world.player.land();
                        }
                    }
                } else if USE_WATER_COLLISION && world.is_entirely_water_cell_at(global.x, global.y)
                {
                    // F4-4 (bughunt 2026-06-09) — fully-water cell ahead. Retail
                    // collides on EntirelyWater land cells for walkers (ACE
                    // LandCell.FindEnvCollisions => Collided); our snap put the
                    // feet on the lakebed, letting the player stroll across the
                    // ocean floor under the rendered water plane. Refuse the
                    // step: revert the lateral advance to the slice-entry XY
                    // (stop at the shoreline) and skip the snap, same mechanism
                    // as the cliff refusal below. (Wading-depth for partially-
                    // water cells is a documented follow-on.)
                    pose.coords.x = entry_local_xy.0;
                    pose.coords.y = entry_local_xy.1;
                } else if USE_TERRAIN_WALKABLE_GATE
                    && z > pose.coords.z
                    && world
                        .terrain_normal_at(global.x, global.y)
                        .map(|n| n.z < holtburger_world::spatial::FLOOR_Z)
                        .unwrap_or(false)
                {
                    // F4-2 (bughunt 2026-06-09) — non-walkable uphill face.
                    // Retail/ACE refuse a contact plane steeper than FloorZ
                    // (~48.4°) and never let it become walkable; our snap
                    // raised Z onto ANY rise, so cliffs were climbable at full
                    // run speed. Refuse the climb: no height is ever gained
                    // onto the face. Walking ALONG the base is unaffected (its
                    // destination terrain is walkable, so this arm isn't
                    // taken).
                    //
                    // G-6 / F4-2 follow-on (2026-06-11) — slide-along-contour.
                    // Instead of the original hard stop at the slice-entry XY,
                    // project the refused lateral onto the slope contour
                    // ([`terrain_contour_slide`], the edge_slide tangent
                    // reused) and take the slid step IF its destination passes
                    // the same gates (not a too-steep uphill face, not a
                    // blocked water cell) — an oblique run at a cliff skids
                    // along the base like retail instead of sticking. Head-on
                    // approaches (negligible tangent) and refused slid
                    // destinations keep the hard stop. Same
                    // USE_TERRAIN_WALKABLE_GATE flag — this branch only runs
                    // with the gate on.
                    let mut slid = false;
                    if let Some(slide) = world.terrain_normal_at(global.x, global.y).and_then(|n| {
                        terrain_contour_slide(
                            Vector3 {
                                x: pose.coords.x - entry_local_xy.0,
                                y: pose.coords.y - entry_local_xy.1,
                                z: 0.0,
                            },
                            n,
                        )
                    }) {
                        // Local deltas equal global deltas (the landblock
                        // offset is a pure translation).
                        let cand_local = (entry_local_xy.0 + slide.x, entry_local_xy.1 + slide.y);
                        let cand_global = (
                            global.x + (cand_local.0 - pose.coords.x),
                            global.y + (cand_local.1 - pose.coords.y),
                        );
                        let water_blocked = USE_WATER_COLLISION
                            && world.is_entirely_water_cell_at(cand_global.0, cand_global.1);
                        if !water_blocked
                            && let Some(cand_z) =
                                world.terrain_height_at(cand_global.0, cand_global.1)
                        {
                            let cand_steep_uphill = cand_z > pose.coords.z
                                && world
                                    .terrain_normal_at(cand_global.0, cand_global.1)
                                    .map(|n| n.z < holtburger_world::spatial::FLOOR_Z)
                                    .unwrap_or(false);
                            // Conservative Z handling: follow the surface only
                            // within the legacy ledge threshold; a bigger Z
                            // delta keeps the entry Z and lets the next tick's
                            // ledge/step logic decide.
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
                        pose.coords.x = entry_local_xy.0;
                        pose.coords.y = entry_local_xy.1;
                    }
                } else {
                    // Wave 5 Phase 5.1 (movement-animation overhaul,
                    // 2026-05-26): walked-off-ledge detection. When the
                    // grounded player's lateral step takes them onto a
                    // terrain cell whose height is significantly below
                    // their current Z, the prior unconditional snap
                    // (`pose.coords.z = z`) teleported them down to the
                    // new terrain — no fall, no animation, no Z arc.
                    // This is the bug the Wave 1 audit called out: the
                    // deleted airborne tween was the only visual cue
                    // for falling, so a walk-off now produces a
                    // T-pose-into-teleport-down.
                    //
                    // Fix: if the step down exceeds the ledge-fall
                    // threshold (treats a normal slope walk / curb as
                    // not a fall), transition the player to airborne via
                    // [`PlayerState::begin_fall`] and DON'T snap Z this
                    // tick — let the gravity integrator on the next
                    // tick handle the drop. The recv loop's
                    // `was_airborne_pre_tick && !is_airborne` landing
                    // diff above + the new walk-off→airborne diff
                    // below produce the right wire-side motion
                    // emissions (`Falling` → `Land`/`Fallen`).
                    //
                    // Physics deep-dive 2026-06-01 (gap 3) — step-DOWN.
                    // When `USE_STEP_UP_DOWN` is set, the threshold is
                    // the per-object `PLAYER_STEP_DOWN_HEIGHT` (1.5 m
                    // for the human body, from Setup `0x0200_0001`):
                    // drops within it snap the feet down to follow the
                    // surface (curbs, short steps), drops beyond it are
                    // real ledges and fall — mirroring ACE's
                    // `Transition` `StepDown` path capped at
                    // `ObjectInfo.StepDownHeight` (`Transition.cs:855`).
                    //
                    // When the gate is off, fall back to the legacy
                    // `LEDGE_FALL_THRESHOLD_M = 0.5` heuristic. That
                    // value was tuned for AC terrain: the heightmap
                    // resolution is 24 m sample spacing with bilinear
                    // interp, so the largest legitimate single-step
                    // descent is ≈0.5 m for the steepest 26° slope
                    // walking forward at 4 m/s @ 60 Hz. Outdoor cliff
                    // edges in Holtburg surrounds typically drop 2-10 m,
                    // so either threshold flags a genuine ledge.
                    const LEDGE_FALL_THRESHOLD_M: f32 = 0.5;
                    if USE_STEP_UP_DOWN {
                        // Physics deep-dive 2026-06-02 (precipice_slide
                        // re-entry) — save the pre-descent pose before
                        // the step-down walkability check so a non-walkable
                        // landing can later be restored and re-attempted
                        // as a precipice slide (CTransition::save_check_pos,
                        // acclient.c:312499-312501). Flag-gated default-off:
                        // when off, nothing is written and the solver is
                        // byte-identical.
                        if USE_PRECIPICE_SLIDE_REENTRY {
                            world.player.backup_pose_for_step_down = Some(pose);
                        }
                        // A7-R2: walkable acceptance — the destination
                        // terrain normal gates the snap (steep downhill
                        // face => Fall). Flag off: height-only decision.
                        let step_down_outcome = if USE_WALKABLE_STEP_DOWN {
                            holtburger_world::spatial::step_down_resolve(
                                pose.coords.z,
                                z,
                                world.terrain_normal_at(global.x, global.y).map(|n| n.z),
                                player_step_down_height(world),
                                holtburger_world::spatial::FLOOR_Z,
                            )
                        } else {
                            holtburger_world::spatial::step_down_decision(
                                pose.coords.z,
                                z,
                                player_step_down_height(world),
                            )
                        };
                        match step_down_outcome {
                            holtburger_world::spatial::StepDownOutcome::Snap(snap_z) => {
                                pose.coords.z = snap_z;
                                // Walkable step-down resolved — clear the
                                // backup pose (no re-entry needed).
                                if USE_PRECIPICE_SLIDE_REENTRY {
                                    world.player.backup_pose_for_step_down = None;
                                }
                            }
                            holtburger_world::spatial::StepDownOutcome::Fall => {
                                // A7-R4 (2026-06-12): restore →
                                // precipice-slide re-attempt — the consumer
                                // of the backup pose the stub deferred.
                                // Retail: edge_slide's walkable branch
                                // restores the saved check position and
                                // skids the move along the crossed cliff
                                // lip (acclient.c:312685-312772, 313980).
                                // Accepts ONLY a walkable re-probed
                                // landing; otherwise the legacy fall path
                                // below runs unchanged. Flag off (default)
                                // = byte-identical (backup never saved).
                                let mut precipice_slid = false;
                                if USE_PRECIPICE_SLIDE_REENTRY
                                    && let Some(backup) =
                                        world.player.backup_pose_for_step_down.take()
                                    && let Some((new_x, new_y, snap_z)) =
                                        attempt_precipice_slide(world, &backup, entry_local_xy)
                                {
                                    pose.coords.x = new_x;
                                    pose.coords.y = new_y;
                                    pose.coords.z = snap_z;
                                    precipice_slid = true;
                                }
                                if !precipice_slid {
                                    world.player.begin_fall();
                                    // A3-D3-5: retail leave-ground launch
                                    // velocity (default-off no-op).
                                    stamp_leave_ground_velocity(
                                        world,
                                        heading,
                                        state,
                                        &capabilities,
                                    );
                                    // Leave Z alone — gravity drops us next
                                    // tick. Genuine ledge fall resolved —
                                    // clear the backup pose.
                                    if USE_PRECIPICE_SLIDE_REENTRY {
                                        world.player.backup_pose_for_step_down = None;
                                    }
                                }
                            }
                        }
                    } else if pose.coords.z - z > LEDGE_FALL_THRESHOLD_M {
                        world.player.begin_fall();
                        // A3-D3-5: retail leave-ground launch velocity
                        // (default-off no-op).
                        stamp_leave_ground_velocity(world, heading, state, &capabilities);
                        // Leave Z alone — let the gravity integrator
                        // drop us next tick.
                    } else {
                        pose.coords.z = z;
                    }
                    // Physics deep-dive 2026-06-02 (precipice_slide
                    // re-entry) — clear the backup pose on the legacy
                    // fallback path (when USE_STEP_UP_DOWN is off, nothing
                    // was ever saved, so this is a defensive no-op). Behind
                    // the default-off flag, so byte-identical when off.
                    if USE_PRECIPICE_SLIDE_REENTRY {
                        world.player.backup_pose_for_step_down = None;
                    }
                }
            }
        } else if indoor_unbaked {
            // Pre-bake gate: skip floor-Z snap entirely. Without
            // a baked AABB or triangles there's no source of
            // floor-Z, and any computed snap would either no-op
            // (ok) or use stale data (not ok).
        } else {
            // 2026-05-10 indoor floor-Z: prefer per-polygon raycast
            // (`highest_floor_z_under`) when the cell's
            // `physics_polygons` are loaded — handles stairs and
            // ramps accurately. The cell AABB's `min.z` is the
            // last-resort lower bound (initial seconds after landblock
            // entry, before the lazy physics bake completes; or the XY
            // off the floor footprint) so the player still doesn't
            // fall through the world — but, under
            // `USE_RAMP_FLOOR_SNAP_FIX`, it is never used as an up-snap
            // target (which would pop the player to the cell minimum on
            // a ramp); see the flag doc.
            let cell_id = world.scene.current_cell(&pose);
            let global = pose.global_coords();
            let triangles = world.scene.cell_triangles(cell_id);
            let cell_aabb = world.scene.cell_aabb(cell_id);
            // Pick a generous "ceiling" Z for the floor query so a
            // player jumping or perched on stairs still finds a
            // floor below them. The cell's max.z is a natural cap;
            // when no AABB is registered, use a far-future value so
            // the raycast doesn't artificially exclude high stairs.
            let ceiling_for_floor_query = cell_aabb
                .map(|a| a.max.z + 1.0)
                .unwrap_or(pose.coords.z + 100.0);
            // 2026-06-02 indoor floor-pop fix: a *real* per-poly
            // triangle floor is the only valid up-snap source. On a
            // ramped/multi-level cell `highest_floor_z_under` returns
            // `None` whenever the XY lands in a gap between floor
            // triangles (tread seams, a sparse poly set, an unbaked
            // segment). The pre-fix code `.or_else(|| aabb.min.z)`'d
            // that into the up-snap, collapsing the player to the
            // cell's LOWEST floor (`aabb.min.z` is the whole-cell
            // minimum, not the floor under the player). `aabb.min.z`
            // is now a last-resort *lower bound* only — it can catch a
            // player who has fallen through, but it never pushes the
            // player DOWN to the cell minimum on a ramp.
            let poly_floor_z = if !triangles.is_empty() {
                holtburger_world::spatial::highest_floor_z_under(
                    triangles,
                    global.x,
                    global.y,
                    ceiling_for_floor_query,
                )
            } else {
                None
            };
            // Lower bound used both by the fall-through guard and the
            // ceiling clamp's `floor_min`. With the fix on, the AABB
            // minimum is purely a floor (never an up-snap target);
            // with it off we reproduce the legacy combined-Option.
            let aabb_floor_z = cell_aabb.map(|a| a.min.z);
            if USE_RAMP_FLOOR_SNAP_FIX {
                // Snap to a real per-poly floor. Two grounded directions:
                //   - feet below the floor → snap UP (catch-up / landing).
                //   - feet above the floor → indoor step-DOWN (see F4-1
                //     below).
                if let Some(floor) = poly_floor_z {
                    let snap_z = floor + 0.005; // 5 mm headroom; matches AC
                    if pose.coords.z < snap_z {
                        // A7-R3: an AIRBORNE indoor touchdown tests the
                        // per-poly landing normal; a refused (near-
                        // vertical) face keeps the fall going. Grounded
                        // snap-up (catch-up) is untouched.
                        let refuse_landing = USE_LANDING_WALKABLE
                            && world.player.is_airborne
                            && !holtburger_world::spatial::landing_allows_touchdown(
                                holtburger_world::spatial::floor_normal_under(
                                    triangles,
                                    global.x,
                                    global.y,
                                    ceiling_for_floor_query,
                                )
                                .map(|n| n.z),
                                holtburger_world::spatial::collision::physics_globals::LANDING_Z,
                            );
                        if !refuse_landing {
                            pose.coords.z = snap_z;
                            // Indoor landing: snap-up triggered while
                            // airborne → touchdown. Outdoor analog above
                            // uses `world.player.land()` likewise.
                            if world.player.is_airborne {
                                world.player.land();
                            }
                        }
                    } else if USE_STEP_UP_DOWN
                        && !world.player.is_airborne
                        && pose.coords.z > snap_z
                    {
                        // F4-1 (bughunt 2026-06-09) — indoor descent. The
                        // outdoor branch above runs `step_down_decision` on
                        // every walk-off; this indoor branch was snap-UP-only
                        // (Phase 6 academy-rubberband fix), so a grounded
                        // player walking DOWN a dungeon stair/ramp or off an
                        // indoor ledge kept the highest Z it ever reached and
                        // hovered on air at the old altitude. Retail/ACE
                        // `Transition.StepDown` is cell-agnostic — it runs for
                        // EnvCells exactly as for land cells, capped at
                        // `ObjectInfo.StepDownHeight` (= PLAYER_STEP_DOWN_HEIGHT,
                        // 1.5 m). Mirror it indoors: a drop within step-down
                        // height snaps the feet down to follow the floor
                        // (stairs/ramps/short steps); a deeper drop begins a
                        // fall and lets the gravity integrator take over next
                        // tick, after which the snap-UP arm above catches the
                        // indoor landing. Grounded-only: while airborne the
                        // gravity arc owns Z and the snap-UP arm handles
                        // touchdown.
                        // A7-R2: indoor walkable acceptance from the
                        // per-poly floor normal. Flag off: height-only.
                        let step_down_outcome = if USE_WALKABLE_STEP_DOWN {
                            holtburger_world::spatial::step_down_resolve(
                                pose.coords.z,
                                snap_z,
                                holtburger_world::spatial::floor_normal_under(
                                    triangles,
                                    global.x,
                                    global.y,
                                    ceiling_for_floor_query,
                                )
                                .map(|n| n.z),
                                player_step_down_height(world),
                                holtburger_world::spatial::FLOOR_Z,
                            )
                        } else {
                            holtburger_world::spatial::step_down_decision(
                                pose.coords.z,
                                snap_z,
                                player_step_down_height(world),
                            )
                        };
                        match step_down_outcome {
                            holtburger_world::spatial::StepDownOutcome::Snap(z) => {
                                pose.coords.z = z;
                            }
                            holtburger_world::spatial::StepDownOutcome::Fall => {
                                world.player.begin_fall();
                                // A3-D3-5: retail leave-ground launch
                                // velocity (default-off no-op).
                                stamp_leave_ground_velocity(world, heading, state, &capabilities);
                                // Leave Z alone — gravity drops us next tick.
                            }
                        }
                    }
                }
                // Fall-through guard: `aabb.min.z` is the last-resort
                // *lower bound* only. Never pushes the player DOWN — it
                // only catches a retained Z that has dropped below the
                // entire cell floor (true fall-through), which also
                // covers the bake window where only the AABB is baked.
                if let Some(aabb_min) = aabb_floor_z {
                    let cell_floor = aabb_min + 0.005;
                    if pose.coords.z < cell_floor {
                        pose.coords.z = cell_floor;
                        if world.player.is_airborne {
                            world.player.land();
                        }
                    }
                }
            } else {
                // Legacy: combined per-poly-or-AABB up-snap (pops to the
                // cell minimum when the per-poly query misses).
                let floor_z = poly_floor_z.or(aabb_floor_z);
                if let Some(floor) = floor_z {
                    let snap_z = floor + 0.005; // 5 mm headroom; matches AC
                    if pose.coords.z < snap_z {
                        pose.coords.z = snap_z;
                        if world.player.is_airborne {
                            world.player.land();
                        }
                    }
                }
            }
            // Ceiling clamp — protect against the player being
            // shoved through the ceiling by a tall jump or a server
            // forced reposition. Uses cell AABB max.z; per-poly
            // ceiling raycast is left for a future commit (rare in
            // practice — AC ceilings are usually higher than the
            // player ever reaches in a normal walk).
            if let Some(aabb) = cell_aabb {
                let ceiling_z = aabb.max.z - holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT;
                // `floor_min` keeps the ceiling clamp from shoving the
                // player below the floor. Prefer the real per-poly
                // floor; otherwise the AABB lower bound. Matches the
                // legacy `floor_z.unwrap_or(aabb.min.z + 0.005)` (the
                // raw floor value, no headroom, exactly as before).
                let floor_min = poly_floor_z.or(aabb_floor_z).unwrap_or(aabb.min.z + 0.005);
                if pose.coords.z > ceiling_z {
                    pose.coords.z = ceiling_z.max(floor_min);
                }
            }
        }
        // Phase 2 (Cohere-D, 2026-05-12): apply local rotation
        // prediction so Q/E feels responsive without waiting for the
        // server's UpdateMotion broadcast roundtrip. `omega.z` is the
        // yaw rate (rad/s) from `local_omega_for_state` —
        // `base_turn_right_omega = (0, 0, +1.5)` for Run, scaled by
        // any `turn_speed` override on the MotionState. Server still
        // owns the canonical heading (UpdateMotion overrides this
        // when it arrives); the local update is purely a "show the
        // user something now" prediction. No-op when the player
        // isn't turning (omega.z near zero), matching the existing
        // forward/strafe path that no-ops on zero velocity.
        //
        // This advances the FACING only. While airborne it keeps turning
        // (retail exempts TurnRight/TurnLeft from the contact gate, see
        // the airborne planar branch above), but it must NOT re-aim the
        // frozen world-space launch velocity: `smoothed_planar` was read
        // before this rotation and is applied to position as a world-frame
        // delta, so turning the rig in flight changes where the player
        // looks without curving the locked trajectory.
        if omega.z.abs() > f32::EPSILON {
            let new_heading = normalize_heading(heading + omega.z * dt_s);
            pose.rotation = Quaternion::from_heading(new_heading);
        }

        // Phase 4 step 3.7 — re-bucket coords if we crossed a 192 m
        // landblock boundary. Without this, the AutonomousPosition
        // packet reports e.g. (94, 200, 94) inside the seeded
        // landblock_id when the player has actually walked into the
        // adjacent landblock — ACE rubber-bands or silently rejects.
        let pose = pose.rebucket_outdoor_landblock();

        // Physics deep-dive 2026-06-02 (retail-interpolate-wire) — step the
        // retail force-position interpolator. No-op unless USE_RETAIL_INTERPOLATE
        // is on (the dispatch early-returns InterpStep::Idle when off, so this is
        // byte-identical by default). When enabled, it eases the local player's
        // pose toward a server-forced target per frame (ACE InterpolationManager
        // + ConstraintManager adjust_offset); the Progressed/Completed outcomes
        // carry the stepped pose, applied here before the runtime write-back.
        let body_id = SpatialBodyId::LocalPlayer(world.player.guid);
        let on_contact = !world.player.is_airborne;
        // Retail interp cap: `fUseAdjustedSpeed_ = 1` (acclient.c:45657)
        // → `get_adjusted_max_speed() * 2.0` (:389227-389241) — a
        // server-driven interpreted RunForward overrides the run-rate
        // base with `forward_speed / current_speed_factor` (FU2/row 32).
        let interp_base = capabilities.resolved_manual_run_speed();
        let max_speed = self
            .movement_managers
            .get(&world.player.guid)
            .and_then(|manager| manager.motion_interp_ref())
            .map(|minterp| minterp.adjusted_max_speed(interp_base))
            .unwrap_or(interp_base)
            * 2.0;
        // Track B1 — the local floor-Z snap above owns the vertical axis
        // while grounded (it just placed the feet on the terrain/cell
        // floor). The force-position interpolator eases the CONTACT-PLANE
        // origin (XY) toward the server target; it must NOT drag Z back to
        // the server-forced height and undo the floor snap (retail re-
        // derives the contact plane after `InterpolateTo`). So when
        // grounded we keep the snapped Z and only adopt the interpolated
        // XY/heading.
        //
        // While AIRBORNE the integrator owns the full pose: `pose` already
        // holds this tick's freshly-integrated ballistic arc. We must NOT
        // step/adopt the force-position interpolator here — its per-frame
        // step reads the STALE start-of-tick `body.pose` (the runtime
        // write-back happens below at `set_local_player_runtime_pose`), and
        // its `!on_contact` early-out (ACE InterpolationManager no-contact
        // path) returns that stale pose verbatim. Adopting it would discard
        // the gravity integration and FREEZE the jump arc for the whole
        // airborne window (the interp also never completes while
        // !on_contact). The installed interpolation stays armed and resumes
        // easing on touchdown. (See the Wave-1 adversarial review finding.)
        let pose = if on_contact {
            let snapped_z = pose.coords.z;
            // Physics-parity 2026-07-03 (dossier A F8): the state-layer
            // wrapper routes a drain-applied velocity into the player's
            // split store via the retail set_velocity entry.
            match world.step_local_force_position(body_id, dt_s, max_speed, on_contact) {
                InterpStep::Progressed { mut pose } | InterpStep::Completed { mut pose } => {
                    pose.coords.z = snapped_z;
                    pose
                }
                _ => pose,
            }
        } else {
            pose
        };

        // A2-P3 (2026-06-12, W3+ S9) — LOCAL sticky step, AFTER interp,
        // BEFORE the runtime write-back (retail chain interp → sticky →
        // constraint, acclient.c:388287-388304). NO contact gate —
        // retail sticky has none (:388519-388601); the airborne arm is
        // safe because sticky reads THIS tick's working `pose`, not the
        // stale `body.pose` (spec S9 §3 L3 step 2; airborne-swing edge
        // flagged for the eye-test list, OPEN Q5). Speed input is the
        // RAW manual run speed (NOT the `* 2.0` interp value) — sticky
        // applies its own `* 5.0` / floor-15 model inside
        // `adjust_offset` (:388569-388579). Z stays with this tick's
        // value (sticky z is zeroed by construction, :388557 — the
        // grounded floor-snap carve-out is preserved).
        let pose = if USE_STICKY_MANAGER {
            let sticky_speed = capabilities.resolved_manual_run_speed();
            match world.scene.step_local_sticky(pose, dt_s, sticky_speed) {
                LocalStickyStep::Stepped(mut stepped) => {
                    stepped.coords.z = pose.coords.z;
                    stepped.rebucket_outdoor_landblock()
                }
                LocalStickyStep::TimedOut => {
                    // Deferred ACE `ClearTarget → cancel_moveto` — these
                    // tails are `&self`; the next `tick()` consumes it.
                    self.sticky_timeout_pending.set(true);
                    pose
                }
                LocalStickyStep::Inactive => pose,
            }
        } else {
            pose
        };

        // Indoor→indoor cell parity (2026-07-18, handoff-6 §3.2): this legacy
        // chain still pins an indoor pose's EnvCell low word (only the
        // entry/exit flips above re-derive it) — but NO re-derive guard is
        // added here because the whole chain is unreachable:
        // `unified_transition_enabled()` is `USE_UNIFIED_TRANSITION ||
        // runtime` (OR-only carrier, const `true`), so every slice returns
        // through `advance_manual_slice_via_transition` at the top of this
        // function (same finding as the fell-through-failsafe re-home,
        // `finish_manual_slice_via_transition`). Both LIVE transition paths
        // re-derive: the faithful marshal (faithful_bridge.rs
        // `scene.current_cell` else-arm) and the approximate pipeline's
        // `step_cell_transit_flips` indoor else-arm (transition.rs — the
        // bridge's indoor pre-bake fallback). If this chain is ever
        // resurrected (const rollback), port the same re-derive before this
        // write-back.
        let _ = world.set_local_player_runtime_pose(pose);
    }

    /// A6-T1/T2 — the local player's per-transition object description +
    /// gate snapshot for the retail pipeline. The flag consts live HERE
    /// (the flag owner); the pure pipeline in
    /// [`holtburger_world::spatial::transition`] receives their values
    /// so its behavior mirrors the legacy chain gate-for-gate.
    pub(crate) fn transition_profile(
        world: &WorldState,
    ) -> (
        holtburger_world::spatial::transition::ObjectInfo,
        holtburger_world::spatial::transition::TransitionGates,
    ) {
        let step_up = if USE_SETUP_STEP_HEIGHTS {
            world.player.step_up_height
        } else {
            None
        };
        let step_down = if USE_SETUP_STEP_HEIGHTS {
            world.player.step_down_height
        } else {
            None
        };
        let object = holtburger_world::spatial::transition::ObjectInfo::for_local_player(
            step_up,
            step_down,
            USE_EDGE_SLIDE && world.player.allow_edge_slide,
            world.player.guid,
        );
        let gates = holtburger_world::spatial::transition::TransitionGates {
            step_up_down: USE_STEP_UP_DOWN,
            walkable_step_down: USE_WALKABLE_STEP_DOWN,
            landing_walkable: USE_LANDING_WALKABLE,
            water_collision: USE_WATER_COLLISION,
            terrain_walkable_gate: USE_TERRAIN_WALKABLE_GATE,
            local_envcell_entry: USE_LOCAL_ENVCELL_ENTRY,
            ramp_floor_snap_fix: USE_RAMP_FLOOR_SNAP_FIX,
            skip_parented_entities: SKIP_PARENTED_ENTITY_COLLISION,
            walkable_reinsert_probe: USE_WALKABLE_REINSERT_PROBE,
            outdoor_static_grounding: USE_OUTDOOR_STATIC_GROUNDING,
            retail_ground: USE_RETAIL_GROUND,
        };
        (object, gates)
    }

    /// Consume the arrival-placement latch (set by `set_player_position_with_sync`
    /// on a teleport `Reset` / force-blip resync). Runs the retail placement
    /// transition (`faithful_find_placement_position`, the port of
    /// `CPhysicsObj::SetPosition`'s `find_placement_position`, acclient.c:313341)
    /// so an arrival that landed the capsule embedded in an env-cell wall is
    /// de-embedded BEFORE the next movement slice sweeps and refuses every step.
    ///
    /// Gated on `faithful_transition_enabled()` (the faithful driver is the only
    /// path the placement port applies to) and INDOOR only — outdoor arrivals use
    /// the existing terrain machinery, so the blast radius stays indoor. When the
    /// begin cell's physics BSP is not yet resident the latch is LEFT SET (the
    /// cell-residency watchdog fetches it; we retry next tick).
    pub(crate) fn consume_pending_arrival_placement(&self, world: &mut WorldState) {
        if !world.player.pending_arrival_placement {
            return;
        }
        // The placement port only applies to the faithful driver path.
        if !self.faithful_transition_enabled() {
            world.player.pending_arrival_placement = false;
            return;
        }
        let Some(pose) = world.local_player_runtime_pose() else {
            // No runtime pose yet — keep the latch and retry next tick.
            return;
        };
        // Outdoor arrivals keep the existing terrain grounding — indoor only.
        if !pose.is_indoors() {
            world.player.pending_arrival_placement = false;
            return;
        }
        // Task-#12 fix 2 (2026-07-20): an arrival pose's cell id is a server
        // claim, not transit continuity — resolve via the arrival resolver
        // (given cell first, then the landblock's true geometric owner; no
        // topological-neighbour walk that can mislabel, retail
        // `CPhysicsObj::AdjustPosition` → `find_visible_child_cell`).
        let begin_cell = world.scene.current_cell_for_arrival(&pose);
        if world.scene.cell_physics_bsp(begin_cell).is_none() {
            // Cell BSP not resident yet — leave the latch set for a later retry.
            return;
        }

        let (object, mut gates) = Self::transition_profile(world);
        gates.outdoor_static_grounding = self.outdoor_static_grounding_enabled();
        gates.retail_ground = self.retail_ground_enabled();

        match holtburger_world::spatial::faithful_bridge::faithful_find_placement_position(
            &*world, &pose, &object, &gates,
        ) {
            Some(outcome) => {
                // FU-11: the placement function reports the TRUE de-embed
                // magnitude (`adjusted_by`, measured arrival-world → settled-world
                // inside the bridge). Do NOT recompute it from
                // `pose.global_coords()` vs `outcome.pose.global_coords()`: the
                // arrival `pose` is CELL-local (server-authored indoor frame) while
                // `outcome.pose` is landblock-local (normalized), so that diff would
                // report the ~120 m frame correction, not the ~0.9 m de-embed.
                let dist = outcome.adjusted_by;
                // Apply the adjusted pose via the runtime-body path WITHOUT
                // emitting a network/authoritative event (same write-back the
                // transition tail uses).
                let _ = world.set_local_player_runtime_pose(outcome.pose);
                if gates.retail_ground {
                    world.player.last_contact_plane = outcome.contact_plane;
                }
                if outcome.grounded {
                    world.player.land();
                } else {
                    world.player.begin_fall();
                }
                world.player.pending_arrival_placement = false;
                crate::arrival_placement_diag::note_engaged();
                // NOTE: warn! is deliberate here (not info!) — the wasm console
                // logger caps at Warn (apps/holtburger-web/src/lib.rs
                // ConsoleWarnLogger), so an info! line is invisible in the
                // browser. This success line fires at most once per teleport
                // arrival (not per-frame → not spammy) and is the soak-11 §5.1
                // observability item: it makes the arrival-placement latch
                // live-verifiable.
                log::warn!(
                    "[arrival-placement] adjusted pose by {:.2}m cell 0x{:08X} grounded={}",
                    dist,
                    outcome.pose.landblock_id.0,
                    outcome.grounded,
                );
            }
            None => {
                // Residency present but the placement search found no valid pose
                // — keep the pose as-is and clear the latch (no retry loop).
                world.player.pending_arrival_placement = false;
                crate::arrival_placement_diag::note_failed();
                log::warn!(
                    "[arrival-placement] placement search failed cell 0x{:08X} (pose kept)",
                    begin_cell,
                );
            }
        }
    }


    /// A6-T1/T2 — ONE manual-drive slice through the retail transition
    /// pipeline. The SHARED driver for both consumers (which is what
    /// makes the T1↔T2 equivalence structural):
    ///   - T1: [`Self::advance_local_pose_for_manual_drive_slice`]'s
    ///     gate-on swap (the legacy handle path).
    ///   - T2: the canonical spine's `simulation.tick` manual arm
    ///     (`client/simulation.rs`), which excludes the local body from
    ///     `SpatialPhysics::solve` and calls this instead.
    ///
    /// Velocity contract: the interpreted-pipeline source
    /// ([`interpreted_velocity_for_state`] — the same Stage-1 branch the
    /// legacy P1 chain uses under `USE_INTERPRETED_VELOCITY = true`,
    /// spec S7 §3 Stage C.1 / OQ2) with the StandingLongJump root and
    /// the airborne frozen-launch-velocity rule. Velocity integration
    /// (incl. the gravity arc) stays OUTSIDE the pipeline — retail
    /// integrates velocity in `update_object` BEFORE `transition()`
    /// consumes only old→new pose (acclient.c:320061).
    ///
    /// Returns `false` when no manual drive is active / prerequisites
    /// are missing (caller falls through; nothing was advanced).
    pub(crate) fn advance_manual_slice_via_transition(
        &self,
        world: &mut WorldState,
        dt: Duration,
    ) -> bool {
        let Some(active) = self.active_drive else {
            return false;
        };
        let ActiveDriveIntent::Manual(state) = active.intent else {
            return false;
        };
        let Some(pose) = world.local_player_runtime_pose() else {
            return false;
        };
        let heading = pose.rotation.to_heading();
        let Ok(capabilities) = world.resolve_self_movement_capabilities() else {
            return false;
        };
        let dt_s = dt.as_secs_f32();

        // USE_CAST_MOVE — the retail autonomy dispatch
        // (`CMotionInterp::apply_current_movement`, acclient.c:344305):
        // while the latch is LOW the INTERPRETED (server-echo) state
        // drives, not raw WASD. The cast gesture occupies the single
        // forward slot (`RawMotionState::ApplyMotion` default arm
        // :332890 / interpreted mirror :332759) at zero locomotion, so
        // forward dies; the sidestep/turn slots are INDEPENDENT
        // (:344147 drives each separately) and whatever the server echo
        // carries keeps flowing — slidecast. Held keys stop driving
        // until a fresh input EDGE raises the latch
        // (ingest_drive_command) — fastcast's tap-to-break and the
        // "fight to move forward" metronome. Gait is preserved so
        // stance-speed bookkeeping is unchanged.
        let state = if self.interpreted_movement_active() {
            Self::interpreted_drive_state(
                self.movement_managers
                    .get(&world.player.guid)
                    .and_then(|manager| manager.motion_interp_ref())
                    .map(|minterp| &minterp.interpreted_state),
                state,
            )
        } else {
            state
        };

        let target_velocity = interpreted_velocity_for_state(heading, state, &capabilities);
        // G-7 / F1-6 — StandingLongJump root (turning stays allowed via
        // omega in the tail).
        let target_velocity = if world.player.standing_long_jump_charge {
            Vector3::zero()
        } else {
            target_velocity
        };
        let smoothed_planar = if world.player.is_airborne {
            // Frozen world-frame launch velocity — mid-air WASD does not
            // re-aim the trajectory (retail contact gate).
            world.player.current_planar_velocity
        } else {
            // Retail direct-set + small-velocity snap (the Stage-1
            // grounded model; see USE_INTERPRETED_VELOCITY). This snap is
            // the locomotion-model emulation and deliberately keeps the
            // slack-less `< 0.0625` planar form; the retail stop check
            // (full 3D, `mag² − 0.25² < 0.0002`, acclient.c:317750) lives
            // in the airborne arm and the landing residual tail, where
            // physics velocity — not the direct-set target — is in play.
            let mut v = target_velocity;
            v.z = 0.0;
            let mag_sq = v.x * v.x + v.y * v.y;
            let threshold_sq =
                PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC * PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC;
            if mag_sq < threshold_sq {
                v.x = 0.0;
                v.y = 0.0;
            }
            world.player.current_planar_velocity = v;
            v
        };
        let raw_delta = Vector3::new(
            smoothed_planar.x * dt_s,
            smoothed_planar.y * dt_s,
            target_velocity.z * dt_s,
        );
        self.finish_manual_slice_via_transition(
            world,
            pose,
            raw_delta,
            heading,
            state,
            &capabilities,
            dt_s,
        );
        true
    }

    /// A6-T1/T2 — the pipeline call + write-back tail shared by the
    /// manual-slice driver above: A7-R6 deferred-ethereal re-check
    /// (entity-side, deliberately OUTSIDE the pipeline per spec §1),
    /// the airborne gravity/terminal-clamp integration (outside — the
    /// pipeline consumes only the resulting Z delta), the
    /// `find_transitional_position` call, contact-transition
    /// bookkeeping (`land`/`begin_fall` + leave-ground stamp + the
    /// `InitLastKnownContactPlane` wall-normal carry), and the legacy
    /// tail (omega rotation prediction, force-position interpolation,
    /// runtime-pose write-back).
    #[allow(clippy::too_many_arguments)]
    fn finish_manual_slice_via_transition(
        &self,
        world: &mut WorldState,
        pose: holtburger_common::position::WorldPosition,
        raw_delta: Vector3,
        heading: f32,
        state: MotionState,
        capabilities: &holtburger_world::SelfMovementCapabilities,
        dt_s: f32,
    ) {
        // A7-R6 — resolve deferred ethereal expiries against the working
        // pose (flag off: no entity carries the pending bit ⇒ no-op).
        if holtburger_world::entity::USE_ETHEREAL_RECHECK {
            let player_global = pose.global_coords();
            let pending: Vec<_> = world
                .entities
                .iter()
                .filter(|e| e.ethereal_recheck_pending)
                .map(|e| {
                    let g = e.position.global_coords();
                    (e.guid, (g.x, g.y), world.entity_collision_radius(e))
                })
                .collect();
            for (guid, center, radius) in pending {
                let overlapping = holtburger_world::spatial::spheres_overlap_xy(
                    (player_global.x, player_global.y),
                    holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
                    center,
                    radius,
                );
                if let Some(entity) = world.entities.get_mut(guid) {
                    entity.resolve_ethereal_recheck(overlapping);
                }
            }
        }

        let was_airborne = world.player.is_airborne;
        let mut raw_delta = raw_delta;
        let mut descending = true;
        let dz = if was_airborne {
            // Retail `UpdatePhysicsInternal` per-quantum order
            // (acclient.c:317701-317786): entry mag² (:317726) →
            // terminal clamp (:317740-317748) → friction slot (:317749;
            // never airborne — gated on ON_WALKABLE_TS, :316108) → stop
            // check (:317750-317756) → position from the CLAMPED/STOPPED
            // old velocity + half-step (:317757-317775) → v += a·q
            // (:317778-317783, unconditional). Stays outside the
            // transition pipeline; the pipeline consumes the deltas.
            let az = -9.8_f32;
            let mut vx = world.player.current_planar_velocity.x;
            let mut vy = world.player.current_planar_velocity.y;
            let mut vz = world.player.vertical_velocity;
            let mut mag2 = vx * vx + vy * vy + vz * vz;
            let d;
            if mag2 > 0.0 {
                if mag2 > MAX_VELOCITY * MAX_VELOCITY {
                    // Two rounding steps — `normalize(v)` then `v *= 50`
                    // (:317742-317747), not a fused `v *= 50/|v|`.
                    let len = mag2.sqrt();
                    vx /= len;
                    vy /= len;
                    vz /= len;
                    vx *= MAX_VELOCITY;
                    vy *= MAX_VELOCITY;
                    vz *= MAX_VELOCITY;
                    mag2 = MAX_VELOCITY * MAX_VELOCITY;
                }
                // Stop check on the ENTRY mag² (post-clamp; retail never
                // recomputes it): zero the FULL 3D velocity when
                // mag² − 0.25² < 0.0002 (:317750-317756 — 0.0002_f32
                // shares bits with retail's 0.00019999999). Fires at a
                // vertical-jump apex; a running jump's planar component
                // keeps mag² above it.
                if mag2 - 0.25 * 0.25 < 0.0002 {
                    vx = 0.0;
                    vy = 0.0;
                    vz = 0.0;
                }
                // Position from the clamped/stopped OLD velocity plus the
                // half-step (:317757-317775); the planar delta replaces
                // the caller's pre-clamp `smoothed_planar * dt`.
                d = vz * dt_s + 0.5 * az * dt_s * dt_s;
                raw_delta.x = vx * dt_s;
                raw_delta.y = vy * dt_s;
            } else {
                // mag² ≤ 0 skips the position add entirely — no lone
                // half-step term on the first from-rest fall quantum
                // (:317726-317735); gravity still rebuilds v below.
                d = 0.0;
                raw_delta.x = 0.0;
                raw_delta.y = 0.0;
            }
            // v += a·q outside the mag² branch (:317778-317783). The
            // stored speed may exceed MAX_VELOCITY by |a|·q until the
            // NEXT quantum's entry clamp re-caps it — retail stores the
            // same overshoot.
            vz += az * dt_s;
            world.player.current_planar_velocity.x = vx;
            world.player.current_planar_velocity.y = vy;
            world.player.vertical_velocity = vz;
            descending = vz <= 0.0;
            d
        } else {
            raw_delta.z
        };

        // Physics-parity 2026-07-03 (dossier B row 42, F10): with
        // ?retailLeash armed the WHOLE intended per-slice offset
        // (manual planar + integrated dz) passes through the COMPOSED
        // retail PositionManager::adjust_offset chain — interp-replace
        // → sticky planar-replace + heading → constraint scale and
        // accumulate ONCE — BEFORE the transition validates the move
        // (:388287-388304 chained at :320029). One interp window
        // advance, one budget burn, one sticky timeout tick per slice;
        // the interp drain rides along (step-then-drain) and its
        // commands land in the chain tail below. Contact input is the
        // PRE-move bit (retail reads `transient_state & 1` before the
        // frame moves). `None` (leash off / no body): the pre-F10
        // constrain hook runs verbatim — passthrough, bit-identical —
        // and the split interp/sticky tail keeps owning the frame.
        let intended_offset = Vector3::new(raw_delta.x, raw_delta.y, dz);
        let interp_base = capabilities.resolved_manual_run_speed();
        // Retail interp cap: `fUseAdjustedSpeed_ = 1` (acclient.c:45657)
        // → `get_adjusted_max_speed() * 2.0` (:389227-389241) — a
        // server-driven interpreted RunForward overrides the run-rate
        // base with `forward_speed / current_speed_factor` (FU2/row 32).
        let interp_max_speed = self
            .movement_managers
            .get(&world.player.guid)
            .and_then(|manager| manager.motion_interp_ref())
            .map(|minterp| minterp.adjusted_max_speed(interp_base))
            .unwrap_or(interp_base)
            * 2.0;
        let chain = world.scene.adjust_local_offset_chain(
            SpatialBodyId::LocalPlayer(world.player.guid),
            pose,
            intended_offset,
            dt_s,
            interp_max_speed,
            interp_base,
            !was_airborne,
        );
        let leash_delta = match &chain {
            Some(out) => out.offset,
            None => world.constrain_local_manual_delta(intended_offset),
        };
        let (object, mut gates) = Self::transition_profile(world);
        // (2026-06-30) — apply the `?roofGrounding=off` runtime carrier over the
        // const default baked by `transition_profile` (mirrors faithful_stepup).
        gates.outdoor_static_grounding = self.outdoor_static_grounding_enabled();
        // (2026-07-02) — apply the `?retailGround=off` runtime carrier.
        gates.retail_ground = self.retail_ground_enabled();
        let end = holtburger_common::position::WorldPosition {
            landblock_id: pose.landblock_id,
            coords: Vector3::new(
                pose.coords.x + leash_delta.x,
                pose.coords.y + leash_delta.y,
                pose.coords.z + leash_delta.z,
            ),
            rotation: pose.rotation,
        };
        let input = holtburger_world::spatial::transition::TransitionInput {
            begin: pose,
            end,
            object,
            airborne: was_airborne,
            descending,
            force_grounded: false,
            gates,
            last_known_wall_normal: world.player.last_known_wall_normal,
            // Retail stationary-fall carry — seed the transition from the
            // persistent counter (retail `CPhysicsObj::transition` seeds from
            // `transient_state` 0x10/0x20, acclient.c:320104-320115); the
            // read-back below persists the result. Without the carry the
            // resting-floor synthesis (validate_transition,
            // acclient.c:312283-312311) can never fire and a geometry-wedged
            // fall (grocer-seam riser: every slice COLLIDED, contact cleared,
            // pose restored) hovers frozen forever with input ignored.
            frames_stationary_fall: world.player.frames_stationary_fall,
            // USE_RETAIL_GROUND: seed the transition with the mover's stored
            // contact plane (retail `get_object_info` → `init_contact_plane`).
            last_contact_plane: world.player.last_contact_plane,
        };
        let outcome = holtburger_world::spatial::transition::find_transitional_position_dispatch(
            &*world,
            &input,
            self.faithful_transition_enabled(),
            self.faithful_outdoor_enabled(),
            self.faithful_stepup_enabled(),
        );
        let mut pose = outcome.pose;
        // FU-3 (2026-07-20) — dynamic-entity collision arm for the LIVE faithful
        // driver (USE_FAITHFUL_ENTITY_COLLISION, default-off). The faithful
        // branch of `find_transitional_position_dispatch` collides only cell
        // env-BSP + baked cell statics; dynamic entities (doors, monsters,
        // players) never block here. When on, clamp the REALIZED lateral
        // residual against collidable entity cylinders, mirroring where the
        // non-faithful chain applies `clamp_delta_against_entities` per-step
        // inside `insert_check_offset` (transition.rs). CRITICAL: XY-only — the
        // grounding/contact-plane/frames_stationary_fall state derived from
        // `outcome` below reads `outcome`, never `pose`, so a blocked entity
        // cannot corrupt grounding. `Entity::is_collidable` already exempts
        // ETHEREAL|IGNORE_COLLISIONS (an open door passes for free); the
        // IGNORE_CREATURES object-state gate is honored like GeometryCaches.
        if self.faithful_transition_enabled()
            && self.faithful_entity_collision_enabled()
            && object.state
                & holtburger_world::spatial::transition::object_info_state::IGNORE_CREATURES
                == 0
        {
            use holtburger_world::spatial::transition::TransitionEnv as _;
            // Same prefilter shape as `GeometryCaches::gather` (transition.rs):
            // realized/requested travel + radius + 2m slack.
            let prefilter = leash_delta.length() + object.radius + 2.0;
            let colliders = world.entity_colliders_near(
                &input.begin,
                prefilter,
                object.self_guid,
                gates.skip_parented_entities,
            );
            if !colliders.is_empty() {
                let begin_g = input.begin.global_coords();
                let realized_g = pose.global_coords();
                // Lateral residual the transition actually realized (global XY;
                // z carried at 0 — entity collision is lateral only).
                let lateral = Vector3::new(
                    realized_g.x - begin_g.x,
                    realized_g.y - begin_g.y,
                    0.0,
                );
                let clamped = holtburger_world::spatial::clamp_delta_against_entities(
                    &colliders,
                    &input.begin,
                    lateral,
                    object.radius,
                );
                // Apply only the CORRECTION. Landblocks are axis-aligned, so a
                // global-XY delta equals a local-XY delta — safe to add to the
                // realized pose's local coords without a rebucket. Z untouched.
                pose.coords.x += clamped.x - lateral.x;
                pose.coords.y += clamped.y - lateral.y;
            }
        }
        // InitLastKnownContactPlane equivalent — a step with no wall
        // leaves the prior tracked plane intact.
        if let Some(n) = outcome.wall_normal {
            world.player.last_known_wall_normal = Some(n);
        }
        // USE_RETAIL_GROUND — the retail `SetPositionInternal` contact-plane
        // copy-out (acclient.c:322538-322590): the stored plane mirrors the
        // transition's result EXACTLY, including clearing when no plane was
        // touched (retail sets `contact_plane_valid` from the transition every
        // frame — a jump arc therefore drops the plane on its first airborne
        // frame and nothing re-seeds mid-air).
        if gates.retail_ground {
            world.player.last_contact_plane = outcome.contact_plane;
        }
        // Retail stationary-fall read-back (`CPhysicsObj::report_collision_end`,
        // acclient.c:321862-321918): once the counter exceeds 1 retail zeroes
        // `m_velocityVector` (the wedged fall stops accumulating speed); the
        // persistent store keeps 1/2 (`transient_state` 0x10/0x20) and clears
        // on 0 and on 3 (3 ⇔ the resting-floor synthesis grounded the mover
        // this frame — `outcome.grounded`/`contact_plane` already carry the
        // synthesized plane through the normal landing tail below).
        //
        // Kill only on the frame the counter ADVANCED: retail kills on every
        // `>1` frame, but retail integrates gravity into the SAME frame's move
        // (`UpdatePhysicsInternal` velocity-then-position, acclient.c:317701-
        // 317786), so a killed fall always moves — and validates — on its next
        // frame. Our airborne lane integrates position from the PREVIOUS
        // slice's velocity, so the slice after a kill is a zero-offset one:
        // `calc_num_steps == 0` skips `validate_transition` (driver_validate.rs
        // :373-387) and the outcome ECHOES the stored counter. Re-killing on
        // that echo would zero the just-integrated gravity velocity forever —
        // the exact frozen-airborne loop this carry exists to break.
        let fsf_advanced =
            outcome.frames_stationary_fall != world.player.frames_stationary_fall;
        if outcome.frames_stationary_fall > 1 && fsf_advanced {
            world.player.current_planar_velocity = Vector3::zero();
            world.player.vertical_velocity = 0.0;
        }
        world.player.frames_stationary_fall = match outcome.frames_stationary_fall {
            1 | 2 => outcome.frames_stationary_fall,
            _ => 0,
        };
        if was_airborne && outcome.grounded {
            // Retail grounded-frame friction on the RESIDUAL physics
            // velocity: `calc_friction` is gated on ON_WALKABLE_TS
            // (acclient.c:316108, acclient.h:3691), first true on the
            // quantum AFTER the transition plants the mover — which is
            // exactly this landing tail (our slice end == retail's next
            // quantum start). sledding=false (players never carry
            // SLEDDING_PS); post-friction, the retail stop slot zeroes
            // the residual when entry mag² − 0.25² < 0.0002
            // (:317750-317756). Acts ONLY on the stored physics velocity
            // (the landing carry / knockback residual) — grounded
            // locomotion direct-sets the planar store from interpreted
            // state on the NEXT slice, so normal walking is untouched.
            // A persistent multi-slice residual channel (retail
            // set_velocity, F8) is not modeled yet; today the residual
            // lives from touchdown until the next grounded direct-set.
            if gates.retail_ground {
                let mut v = Vector3::new(
                    world.player.current_planar_velocity.x,
                    world.player.current_planar_velocity.y,
                    world.player.vertical_velocity,
                );
                let mag2 = v.dot(&v);
                // Grounded via terrain snap may carry no explicit plane;
                // flat normal makes the projection a no-op (pure decay).
                let normal = outcome
                    .contact_plane
                    .map(|(plane, _)| plane.normal)
                    .unwrap_or(Vector3::new(0.0, 0.0, 1.0));
                let friction = if USE_RETAIL_GROUND_FRICTION {
                    PLAYER_GROUND_FRICTION_RETAIL
                } else {
                    PLAYER_GROUND_FRICTION_PER_SEC
                };
                calc_friction(&mut v, normal, mag2, friction, false, dt_s);
                if mag2 - 0.25 * 0.25 < 0.0002 {
                    v = Vector3::zero();
                }
                world.player.current_planar_velocity.x = v.x;
                world.player.current_planar_velocity.y = v.y;
                world.player.vertical_velocity = v.z;
            }
            world.player.land();
        }
        if !was_airborne && !outcome.grounded {
            world.player.begin_fall();
            // A3-D3-5: retail leave-ground launch velocity
            // (default-off no-op).
            stamp_leave_ground_velocity(world, heading, state, capabilities);
        }
        // USE_SLIDE_FRAME_FRICTION (DEFAULT OFF — deviation escape hatch):
        // friction on a contact-but-NOT-grounded slide frame. Retail
        // applies NO friction here — `calc_friction` is gated on
        // ON_WALKABLE_TS (acclient.c:316108), never set by a too-steep
        // plane — so a retail cliff slide keeps full gravity acceleration
        // while the transition pins the pose to the face. The retail
        // grounded-residual placement is the landing tail above.
        if USE_SLIDE_FRAME_FRICTION
            && gates.retail_ground
            && !outcome.grounded
            && let Some((plane, _)) = outcome.contact_plane
        {
            let mut v = Vector3::new(
                world.player.current_planar_velocity.x,
                world.player.current_planar_velocity.y,
                world.player.vertical_velocity,
            );
            let mag2 = v.dot(&v);
            calc_friction(
                &mut v,
                plane.normal,
                mag2,
                PLAYER_GROUND_FRICTION_RETAIL,
                true, // Sledding — retail sets it on the steep-slide state
                dt_s,
            );
            world.player.current_planar_velocity.x = v.x;
            world.player.current_planar_velocity.y = v.y;
            world.player.vertical_velocity = v.z;
        }

        // Fell-through-world failsafe (2026-07-01, re-homed 2026-07-02).
        // Originally landed in the LEGACY slice body (commit 0287828f), which
        // `USE_UNIFIED_TRANSITION` made unreachable — `airborne_secs` never
        // accumulated and the failsafe never ran (the "@teletome is the only
        // rescue" symptom). This is the LIVE-path home: accumulate airborne
        // time each slice; after a freefall longer than any legitimate drop
        // (6 s) AND a depth well below the outdoor terrain at the mover's
        // global XY, re-seat the pose on the terrain floor (clear a stale
        // indoor cell to the outdoor bucket, rebucket, snap z, land()).
        const FELL_THROUGH_MIN_AIRBORNE_SECS: f32 = 6.0;
        const FELL_THROUGH_TERRAIN_MARGIN: f32 = 50.0;
        if world.player.is_airborne {
            world.player.airborne_secs += dt_s;
            if world.player.airborne_secs >= FELL_THROUGH_MIN_AIRBORNE_SECS {
                let global = pose.global_coords();
                if let Some(tz) = world.terrain_height_at(global.x, global.y)
                    && pose.coords.z < tz - FELL_THROUGH_TERRAIN_MARGIN
                {
                    log::warn!(
                        "[fell-through-failsafe] airborne {:.1}s at z={:.1} (terrain {:.1}) cell 0x{:08X} — re-seating on terrain",
                        world.player.airborne_secs,
                        pose.coords.z,
                        tz,
                        pose.landblock_id.0,
                    );
                    pose.landblock_id = Guid((pose.landblock_id.0 & 0xFFFF_0000) | 0x0001);
                    pose.coords.z = tz + 0.005;
                    pose = pose.rebucket_outdoor_landblock().normalize_outdoor_cell();
                    world.player.land();
                }
            }
        } else {
            world.player.airborne_secs = 0.0;
        }

        // Legacy tail: local rotation prediction + force-position
        // interpolation + runtime write-back (same shape as the legacy
        // slice's tail; the pipeline already rebucketted per step).
        let omega = local_omega_for_state(state, capabilities);
        if omega.z.abs() > f32::EPSILON {
            let new_heading = normalize_heading(heading + omega.z * dt_s);
            pose.rotation = Quaternion::from_heading(new_heading);
        }
        let body_id = SpatialBodyId::LocalPlayer(world.player.guid);
        let on_contact = !world.player.is_airborne;
        // (Interp cap `interp_max_speed` hoisted above the F10 chain
        // call — same value; nothing between mutates the managers or
        // capabilities.) F10: while the chain owns the frame
        // (`chain.is_some()`) this split interp step is SKIPPED — the
        // chain already advanced the window, chained the constraint
        // and drained; running it again would double-book both.
        let pose = if on_contact && chain.is_none() {
            let snapped_z = pose.coords.z;
            // Physics-parity 2026-07-03 (dossier A F8): the state-layer
            // wrapper routes a drain-applied velocity into the player's
            // split store via the retail set_velocity entry.
            match world.step_local_force_position(body_id, dt_s, interp_max_speed, on_contact) {
                InterpStep::Progressed { mut pose } | InterpStep::Completed { mut pose } => {
                    pose.coords.z = snapped_z;
                    pose
                }
                _ => pose,
            }
        } else {
            pose
        };

        // A2-P3 (2026-06-12, W3+ S9) — LOCAL sticky step, AFTER interp,
        // BEFORE the runtime write-back (retail chain interp → sticky →
        // constraint, acclient.c:388287-388304). NO contact gate —
        // retail sticky has none (:388519-388601); the airborne arm is
        // safe because sticky reads THIS tick's working `pose`, not the
        // stale `body.pose` (spec S9 §3 L3 step 2; airborne-swing edge
        // flagged for the eye-test list, OPEN Q5). Speed input is the
        // RAW manual run speed (NOT the `* 2.0` interp value) — sticky
        // applies its own `* 5.0` / floor-15 model inside
        // `adjust_offset` (:388569-388579). Z stays with this tick's
        // value (sticky z is zeroed by construction, :388557 — the
        // grounded floor-snap carve-out is preserved). F10: skipped on
        // chain-owned frames (the chain ran sticky's use_time + pull
        // pre-transition).
        let pose = if USE_STICKY_MANAGER && chain.is_none() {
            let sticky_speed = capabilities.resolved_manual_run_speed();
            match world.scene.step_local_sticky(pose, dt_s, sticky_speed) {
                LocalStickyStep::Stepped(mut stepped) => {
                    stepped.coords.z = pose.coords.z;
                    stepped.rebucket_outdoor_landblock()
                }
                LocalStickyStep::TimedOut => {
                    // Deferred ACE `ClearTarget → cancel_moveto` — these
                    // tails are `&self`; the next `tick()` consumes it.
                    self.sticky_timeout_pending.set(true);
                    pose
                }
                LocalStickyStep::Inactive => pose,
            }
        } else {
            pose
        };

        // F10 chain tail — the chain-owned frame's side effects:
        // heading writer (sticky over interp node — the offset frame's
        // last writer, :388593-388600 over :389269) applied AFTER the
        // omega turn, the same sticky-wins order the split tail
        // produced; drain SetVelocity → the player's split store (the
        // F8 route mutations.rs applies for the split sites); a
        // recovery blip (SetPosition — retail SetPositionSimple,
        // :389320-389360) adopts the node pose as the frame's final
        // pose, heading included.
        let pose = match chain {
            Some(out) => {
                let mut pose = pose;
                if let Some(rotation) = out.rotation {
                    pose.rotation = rotation;
                }
                if out.sticky_timed_out {
                    // Deferred ACE `ClearTarget → cancel_moveto` — same
                    // deferral as the split sticky arm above.
                    self.sticky_timeout_pending.set(true);
                }
                let mut blip = None;
                for command in out.commands {
                    match command {
                        holtburger_world::spatial::InterpolationCommand::SetPosition(p) => {
                            blip = Some(p);
                        }
                        holtburger_world::spatial::InterpolationCommand::SetVelocity(v) => {
                            world.player.set_velocity(v);
                        }
                    }
                }
                blip.unwrap_or(pose)
            }
            None => pose,
        };

        let _ = world.set_local_player_runtime_pose(pose);
    }

    /// A6-T2 test seam + spine helper — whether a Manual drive is the
    /// active drive (the spine's simulation arm needs to know whether
    /// the manual transition driver applies).
    pub(crate) fn has_active_manual_drive(&self) -> bool {
        matches!(
            self.active_drive,
            Some(ActiveDriveState {
                intent: ActiveDriveIntent::Manual(_),
                ..
            })
        )
    }

    /// A6-T1/T2 test seam: install a Manual active drive directly. An
    /// active manual drive implies the post-first-edge autonomy state
    /// (retail `DoMotion` acclient.c:317325), so the latch rises too.
    #[cfg(test)]
    pub(crate) fn set_active_manual_drive_for_test(&mut self, state: MotionState) {
        self.last_move_was_autonomous = true;
        self.active_drive = Some(ActiveDriveState::manual(state, None));
    }

    /// G-7 / F1-6 — the UN-rooted interpreted-intent planar velocity for
    /// the currently held manual drive state. Used by the Jump arm at a
    /// standing-long-jump release: while the charge roots the integrator
    /// (planar store ~0), retail launches with
    /// `get_leave_ground_velocity = get_state_velocity()` — the velocity
    /// the held keys WOULD produce (MotionInterp.cs:654-663). Returns
    /// `None` when no manual intent is active or capabilities are
    /// unavailable (caller falls back to the integrator store).
    pub(crate) fn manual_intent_velocity(&self, world: &WorldState) -> Option<Vector3> {
        let ActiveDriveIntent::Manual(state) = self.active_drive.as_ref()?.intent else {
            return None;
        };
        let pose = world.local_player_runtime_pose()?;
        let heading = pose.rotation.to_heading();
        let capabilities = world.resolve_self_movement_capabilities().ok()?;
        Some(if USE_INTERPRETED_VELOCITY {
            interpreted_velocity_for_state(heading, state, &capabilities)
        } else {
            local_velocity_for_state(heading, state, &capabilities)
        })
    }

    pub(crate) fn current_local_solve_body_input(
        &self,
        world: &WorldState,
    ) -> Option<SolveBodyInput> {
        let guid = world.player.guid;
        if guid == Guid::NULL {
            return None;
        }

        if world.scene.body(SpatialBodyId::LocalPlayer(guid)).is_none()
            && world.player_landblock().is_none()
        {
            return None;
        }

        let body_id = SpatialBodyId::LocalPlayer(guid);
        let pose = world.local_player_runtime_pose()?;
        let (velocity, omega) = match self.active_drive.map(|active| active.intent) {
            Some(ActiveDriveIntent::Manual(state)) => {
                let heading = pose.rotation.to_heading();
                match world.resolve_self_movement_capabilities() {
                    // G-7 / F1-6 — StandingLongJump root mirrors the manual
                    // slice above: zero locomotion, turning allowed.
                    Ok(capabilities) if world.player.standing_long_jump_charge => {
                        (Vector3::zero(), local_omega_for_state(state, &capabilities))
                    }
                    Ok(capabilities) => (
                        local_velocity_for_state(heading, state, &capabilities),
                        local_omega_for_state(state, &capabilities),
                    ),
                    Err(error) => {
                        log::warn!(
                            "manual local solve missing self-movement capabilities: {error}"
                        );
                        (Vector3::zero(), Vector3::zero())
                    }
                }
            }
            _ => (Vector3::zero(), Vector3::zero()),
        };

        Some(SolveBodyInput::velocity(
            body_id,
            pose,
            world
                .runtime_body_view(body_id)
                .map(|body| body.contact)
                .unwrap_or(holtburger_world::ContactState::Unknown),
            velocity,
            omega,
        ))
    }

    fn reconcile_server_controlled_projection(&mut self, world: &WorldState, now: Instant) {
        let Some(projection) = self.server_controlled_projection else {
            return;
        };

        // Track B1 — bounded-age staleness. A MoveToObject install carries
        // no timeout of its own and DRIVES the player every tick, so a
        // dropped terminating Stop/Invalid would otherwise drag the avatar
        // toward a stale target forever. Abandon it past the max age.
        if let Some(installed_at) = self.server_controlled_projection_installed_at {
            if now.saturating_duration_since(installed_at) >= SERVER_PROJECTION_MAX_AGE {
                log::info!(
                    "movement: abandoning stale server-controlled projection (age >= {:?}) target {:?}",
                    SERVER_PROJECTION_MAX_AGE,
                    projection.target_pose
                );
                self.clear_server_controlled_projection();
                return;
            }
        }

        let Some(current_pose) = world.local_player_runtime_pose() else {
            return;
        };

        // Track B1 — landblock divergence. When the player's landblock no
        // longer matches the projection target's block (beyond a one-cell
        // tolerance per axis) the per-frame drive — which only nudges
        // within the target block — can never converge, so CLEAR the
        // projection rather than early-returning and driving toward a
        // stale cross-block target every tick.
        let (cur_lb_x, cur_lb_y) = current_pose.landblock_coords();
        let (tgt_lb_x, tgt_lb_y) = projection.target_pose.landblock_coords();
        let lb_dx = (cur_lb_x as i32 - tgt_lb_x as i32).unsigned_abs();
        let lb_dy = (cur_lb_y as i32 - tgt_lb_y as i32).unsigned_abs();
        if lb_dx > SERVER_PROJECTION_LANDBLOCK_TOLERANCE
            || lb_dy > SERVER_PROJECTION_LANDBLOCK_TOLERANCE
        {
            log::info!(
                "movement: abandoning server-controlled projection on landblock divergence (player {:?} vs target {:?})",
                current_pose.landblock_id,
                projection.target_pose.landblock_id
            );
            self.clear_server_controlled_projection();
            return;
        }

        if current_pose.distance_to(&projection.target_pose) <= 0.05 {
            log::info!(
                "movement: completed server-controlled projection at {:?}",
                projection.target_pose
            );
            self.clear_server_controlled_projection();
        }
    }

    pub(crate) fn record_force_position_sequence(&mut self, force_position_sequence: u16) {
        self.sequence_diagnostics
            .record_force_position_sequence(force_position_sequence);
    }

    pub(crate) fn record_autonomous_position_sequences(
        &mut self,
        teleport_sequence: u16,
        force_position_sequence: u16,
        server_control_sequence: u16,
    ) {
        self.sequence_diagnostics
            .record_autonomous_position_sequences(
                teleport_sequence,
                force_position_sequence,
                server_control_sequence,
            );
    }

    pub(crate) fn record_server_control_sequence(&mut self, server_control_sequence: u16) {
        self.sequence_diagnostics
            .record_server_control_sequence(server_control_sequence);
    }

    /// A13-W1 (2026-06-11, unification survey): SINGLE consumption site
    /// for the self-movement sequence `WorldEvent`s the canonical world
    /// handlers emit (`SelfServerControlledMotion` /
    /// `SelfUpdatePosition` / `SelfAutonomousPosition`). The native
    /// runtime (`client/messages.rs::handle_world_events`) and the wasm
    /// recv loop (`?wireStatePacks=stage1` routed path) both call THIS
    /// function, so the sequence-diagnostics records can never drift
    /// between the two targets again (the exact "fix lands in cli,
    /// regresses in wasm" class the survey's §3 row 3 documents).
    ///
    /// Retail analog: both C2S position packs echo the SAME
    /// `CPhysicsObj::update_times[4/5/6/8]` quartet captured at receive
    /// time (`CommandInterpreter::SendMovementEvent`
    /// acclient.c:718175-718187, `SendPositionEvent` :718225-718239).
    /// Our authoritative quartet copy lives on `world.player` (written
    /// by `holtburger_world::player::mutations`); these records feed
    /// the [`MovementSequenceDiagnostics`] observability mirror only.
    ///
    /// NOTE: the native runtime's `SelfServerControlledMotion` follow-on
    /// (`simulation.handle_server_controlled_movement`) and the F2-3
    /// deferred-LoginComplete trigger stay with their owners — this
    /// helper owns ONLY the sequence records both targets share.
    pub(crate) fn apply_self_movement_world_events(
        &mut self,
        events: &[holtburger_world::WorldEvent],
    ) {
        use holtburger_world::WorldEvent;
        for event in events {
            match event {
                WorldEvent::SelfServerControlledMotion { data, .. } => {
                    self.record_server_control_sequence(data.server_control_sequence);
                    // USE_CAST_MOVE — the retail wire-latch write
                    // (`SmartBox::SetObjectMovement`, acclient.c:311185-
                    // 311193): EVERY accepted self motion that unpacks
                    // stamps the latch with the message's autonomous flag
                    // — GENERAL, no gesture classification (the old
                    // window's classifier missed shapes and let held-W
                    // drive through casts). Cast windups/gestures,
                    // FinishCast's returning Ready, and MoveTo/TurnTo
                    // directives all rightly take interpreted control;
                    // the emit gate (handlers/player.rs, accepted &&
                    // !is_autonomous) makes this a LOWER-only write.
                    self.note_server_authored_motion(data.is_autonomous);
                }
                WorldEvent::SelfUpdatePosition {
                    force_position_sequence,
                    ..
                } => {
                    self.record_force_position_sequence(*force_position_sequence);
                }
                WorldEvent::SelfAutonomousPosition {
                    teleport_sequence,
                    force_position_sequence,
                    server_control_sequence,
                } => {
                    self.record_autonomous_position_sequences(
                        *teleport_sequence,
                        *force_position_sequence,
                        *server_control_sequence,
                    );
                }
                _ => {}
            }
        }
    }

    /// A3-D3 (2026-06-12): sibling of
    /// [`Self::apply_self_movement_world_events`] — consume the
    /// movement-event stream into the per-entity `MovementManager`
    /// registry (the `unpack_movement` Stage-3 semantics). Called from
    /// BOTH the native event pass (`client/messages.rs::
    /// handle_world_events`) and the wasm `?wireStatePacks=stage1`
    /// consumption site — one path, the A13 rule. Gated by the
    /// default-off [`USE_UNPACK_MOVEMENT_SEMANTICS`] const: flag-off,
    /// this is a no-op and the registry never allocates.
    ///
    /// Lanes:
    /// - `EntityMovementEvent` — remote entities, unconditional
    ///   per-message (retail preamble semantics);
    /// - `SelfServerControlledMotion` — the local player, structurally
    ///   gated accepted-&&-!autonomous at the emit site
    ///   (handlers/player.rs:96-107) so an ACE echo of the player's own
    ///   autonomous motion never runs the preamble (spec §3a.2, OPEN
    ///   QUESTION 1: a deliberate, documented deviation from retail's
    ///   unconditional preamble). A3-D3 driver (M4.3): the local event
    ///   now carries the REAL `target_exists` + case-6 target dims
    ///   resolved at the emit site (the old `false` placeholder is
    ///   closed).
    /// - `EntityDespawned` — registry prune.
    pub(crate) fn apply_movement_world_events(&mut self, events: &[holtburger_world::WorldEvent]) {
        if !USE_UNPACK_MOVEMENT_SEMANTICS {
            return;
        }
        self.apply_movement_world_events_ungated(events);
    }

    /// The gate-free body of [`Self::apply_movement_world_events`] —
    /// split out so the Lane-A unit tests can exercise the registry
    /// while the const ships default-off (the spec's "land flag-off
    /// with these green" rule).
    pub(crate) fn apply_movement_world_events_ungated(
        &mut self,
        events: &[holtburger_world::WorldEvent],
    ) {
        for event in events {
            match event {
                WorldEvent::EntityMovementEvent {
                    guid,
                    data,
                    target_exists,
                    object_radius,
                    object_height,
                } => {
                    let manager = self.movement_managers.entry(*guid).or_default();
                    let _effects = manager.apply_unpacked_movement(
                        data,
                        *target_exists,
                        *object_radius,
                        *object_height,
                    );
                }
                WorldEvent::SelfServerControlledMotion {
                    data,
                    target_exists,
                    object_radius,
                    object_height,
                } => {
                    // A3-D3 driver (M4.3): the local lane now carries
                    // the REAL target_exists + dims (the documented
                    // `false` placeholder is closed).
                    // USE_SLIDE_CAST — capture the held manual
                    // sidestep/turn BEFORE the manager borrow (normal
                    // form: signed unit speed, negative = left).
                    // Step 5 (verdict §3.3): flag-on, the persist knob
                    // is the INTERPRETER's `slidecast_persist` config
                    // (the `?slideCast` alias, seeded at construction);
                    // the legacy carrier stays the flag-off predicate.
                    // An unconstructed interpreter (no key edge yet)
                    // falls back to the carrier — same alias source.
                    let slidecast_persist = if self.cmd_interp_enabled() {
                        self.command_interpreter
                            .as_ref()
                            .map_or_else(|| self.slide_cast_enabled(), |i| i.slidecast_persist)
                    } else {
                        self.slide_cast_enabled()
                    };
                    let held = self.last_manual_drive.filter(|_| slidecast_persist);
                    let held_sidestep = held.and_then(|state| state.sidestep).map(|s| match s {
                        SidestepLocomotion::StrafeLeft => -1.0,
                        SidestepLocomotion::StrafeRight => 1.0,
                    });
                    let held_turn = held.and_then(|state| {
                        state.turning.map(|turn| {
                            let magnitude = state.turn_speed.unwrap_or(1.0).abs();
                            match turn {
                                Turn::Left => -magnitude,
                                Turn::Right => magnitude,
                            }
                        })
                    });
                    let manager = self.movement_managers.entry(data.guid).or_default();
                    // Retail weenie vfptr[5] "player-controlled object"
                    // is a STATIC property of the local player
                    // (acclient.c:344411) — install it on the local
                    // registry entry so the autonomous echo-skip
                    // engages; idempotent per-unpack. The remote lane
                    // (EntityMovementEvent) must NOT get this.
                    manager.set_player_controlled(true);
                    let _effects = manager.apply_unpacked_movement(
                        data,
                        *target_exists,
                        *object_radius,
                        *object_height,
                    );
                    // USE_SLIDE_CAST — the held strafe/turn ride
                    // through the General stomp (slidecast; see the
                    // const + `persist_held_manual_axes` docs). Forward
                    // is never persisted — the gesture keeps the slot.
                    if held_sidestep.is_some() || held_turn.is_some() {
                        manager.persist_held_manual_axes(data, held_sidestep, held_turn);
                    }
                }
                WorldEvent::EntityDespawned(guid) => {
                    self.movement_managers.remove(guid);
                }
                _ => {}
            }
        }
    }

    /// A4-Q2 (2026-06-12, W3+ S5) — renderer `AnimationDone` signal:
    /// the wasm `notifyAnimationDone` export lands here. Retail chain:
    /// `AnimDoneHook::Execute` → `CPhysicsObj::Hook_AnimDone` →
    /// `CPartArray::AnimationDone` →
    /// `MotionTableManager::AnimationDone`
    /// (`acclient.c:342336` → `:317087` → `:325080` → `:329873`).
    /// Targets the LOCAL player's queue (the `MovementSystem`-owned
    /// instance the A4-Q1 pump drains); non-local guids are filtered
    /// at the wasm recv arm (per-entity instances are DESIGN Stage-3
    /// scope). Gated by the default-off [`USE_MOTION_TABLE_QUEUE`]
    /// const — flag-off this is a compile-time no-op; flag-on it is
    /// STILL harmlessly inert on an empty queue (the
    /// `acclient.c:329884` head-null guard inside `animation_done`).
    /// Resulting `MotionDone` events ride the EXISTING per-tick pump
    /// drain in [`Self::tick`] — no second drain site.
    pub(crate) fn notify_animation_done(&mut self, success: bool) {
        if !USE_MOTION_TABLE_QUEUE {
            return;
        }
        self.notify_animation_done_ungated(success);
    }

    /// The gate-free body of [`Self::notify_animation_done`] — split
    /// out (the A3-D3 `_ungated` house pattern) so the Lane-A unit
    /// tests can exercise the system-level path while the const ships
    /// default-off.
    pub(crate) fn notify_animation_done_ungated(&mut self, success: bool) {
        self.motion_table_manager.animation_done(success);
    }

    /// A4/SA4F (2026-06-12) — the PER-GUID renderer `AnimationDone`
    /// route (retail has no local-only filter: `AnimDoneHook::Execute`
    /// targets one object's own queue, acclient.c:342336-342338 →
    /// :317087 → :325080-325086 → :329873; the wasm recv-arm local
    /// drop was OUR staging artifact, now retired).
    ///
    /// 1. `is_local` → the existing [`Self::notify_animation_done`]
    ///    (keeps the `USE_MOTION_TABLE_QUEUE` gate + the S9 unstick
    ///    bubble exactly as landed — the system-level instance's
    ///    `MotionDone` events ride the per-tick pump drain).
    /// 2. ALWAYS → the registry [`MovementManager`] for `guid`, when
    ///    one exists. Map-miss is a no-op (despawned guids are pruned
    ///    on `EntityDespawned`), so this half needs no const gate: it
    ///    is inert by construction unless a default-off lane
    ///    (`USE_UNPACK_MOVEMENT_SEMANTICS` wire events / the
    ///    `?wasmPursuit` input lane) created the manager.
    ///
    /// Spec SA4F §6 risk 2 (local dual-instance double-pop): one local
    /// notify reaches BOTH local queues; their enqueue lanes are
    /// disjoint today (rig lane vs lattice spine) and the
    /// acclient.c:329884 head-null guard no-ops the empty one —
    /// unification of the two local instances is the Stage-3 follow-on
    /// (spec §7 OQ-1 fallback: keep both, document). Spec §7 OQ-3
    /// fallback: the registry manager's unstick request is DROPPED
    /// here (remote sticky is the F3-4 JS pin / A2-P3 owner's scope).
    pub(crate) fn notify_animation_done_for(&mut self, guid: Guid, is_local: bool, success: bool) {
        if is_local {
            self.notify_animation_done(success);
        }
        if let Some(manager) = self.movement_managers.get_mut(&guid) {
            let _unstick = manager.animation_done(success);
        }
    }

    /// A4-Q3 (2026-06-12, unification survey) — exit-world drain:
    /// retail cancels (never plays out) every pending one-shot across
    /// an enter/exit-world transition — `CPhysicsObj::exit_world` →
    /// `CPartArray::HandleExitWorld` →
    /// `MotionTableManager::HandleExitWorld` drains the queue with
    /// `AnimationDone(success=0)` and `MovementManager::HandleExitWorld`
    /// drains the interp (acclient.c:322215-322220 → :325128-325136 →
    /// :329940-329947, :339411-339417). Our trigger is `PlayerTeleport`
    /// (the portal/teleport transit — retail routes a portal through
    /// object exit-world into portal space; we model the one
    /// transition), called from BOTH the native recv arm
    /// (`client/messages.rs`) and the wasm recv arm (`lib.rs`) — the
    /// F2-3 dual-site pattern; neither runtime routes `PlayerTeleport`
    /// into the movement world-event pass unconditionally, so the recv
    /// arms own the trigger.
    ///
    /// Routing mirrors [`Self::notify_animation_done_for`] exactly:
    /// 1. `is_local` → the system-level A4-Q1 queue, gated by the
    ///    default-off [`USE_MOTION_TABLE_QUEUE`] const (flag-off this
    ///    half is a compile-time no-op; flag-on the resulting
    ///    `MotionDone(success=0)` events ride the EXISTING per-tick
    ///    pump drain in [`Self::tick`] — no second drain site, the
    ///    A4-Q2 rule).
    /// 2. ALWAYS → the registry [`MovementManager`] for `guid` (its own
    ///    queue + interp, full retail order inside
    ///    `MovementManager::handle_exit_world`). Map-miss is a no-op,
    ///    so this half needs no const gate: inert by construction
    ///    unless a default-off lane created the manager (the SA4F
    ///    precedent). The unstick request is DROPPED: retail's
    ///    `teleport_hook` calls `PositionManager::UnStick` itself
    ///    (acclient.c:322250-322252) — a teleport unsticks by
    ///    construction.
    ///
    /// Empty queues no-op on both routes, so a stray/duplicate call
    /// (e.g. the JS `?mtQueue` cancellation notify landing after this
    /// drain) is harmless (acclient.c:329884 head-null guard).
    pub(crate) fn handle_exit_world_for(&mut self, guid: Guid, is_local: bool) {
        if is_local && USE_MOTION_TABLE_QUEUE {
            self.handle_exit_world_local_ungated();
        }
        if let Some(manager) = self.movement_managers.get_mut(&guid) {
            let _unstick = manager.handle_exit_world();
        }
    }

    /// The gate-free local half of [`Self::handle_exit_world_for`] —
    /// split out (the A3-D3 `_ungated` house pattern) so the Lane-A
    /// unit tests can exercise the system-level drain while the const
    /// ships default-off.
    pub(crate) fn handle_exit_world_local_ungated(&mut self) {
        self.motion_table_manager.handle_exit_world();
    }

    /// A4-Q2 test seam: the local player's pending-animation queue.
    #[cfg(test)]
    pub(crate) fn motion_table_manager_mut(&mut self) -> &mut MotionTableManager {
        &mut self.motion_table_manager
    }

    /// Post-flip diag: the local registry minterp's pending
    /// completion-node count (the `player_motions_pending` seam's queue
    /// term). Read per-tick by the wasm TickMovement arm into the
    /// `movementPendingMotionsDiag` export — live A/B legs assert the
    /// retail enqueue + completion-clock drain with it.
    pub(crate) fn local_registry_pending_motions(&self, local_guid: Guid) -> usize {
        if local_guid == Guid::NULL {
            return 0;
        }
        self.movement_managers
            .get(&local_guid)
            .map_or(0, |manager| manager.pending_motions_len())
    }

    /// WS16 diag (2026-07-12): pack the movement-arbitration snapshot the cast
    /// surface reads (`__diag.cast.movementSnapshot()`). The autonomy latch is
    /// always meaningful; the forward-slot occupancy is the local registry
    /// minterp's interpreted forward slot — a cast gesture parks a Substate
    /// there at zero locomotion (the SLIDECAST mechanism, interp_state.rs:34).
    /// The minterp is lazily created, so occupancy reads `none` until the
    /// player first moves/casts — acceptable for a diagnostic. Bit layout
    /// documented on `lib::CAST_ARBITRATION_DIAG`.
    pub(crate) fn cast_arbitration_diag(&self, local_guid: Guid) -> u32 {
        let mut out: u32 = 0;
        if self.last_move_was_autonomous {
            out |= 0x1;
        }
        if self.cast_move_enabled() {
            out |= 0x2;
        }
        if self.slide_cast_enabled() {
            out |= 0x4;
        }
        // Reach the interpreted forward command exactly as the drive path does
        // (`&minterp.interpreted_state`, system.rs:2831) — the field lives on
        // InterpretedState, NOT on CommandInterpreter.
        let fwd = self
            .movement_managers
            .get(&local_guid)
            .and_then(|manager| manager.motion_interp_ref())
            .and_then(|minterp| minterp.interpreted_state.forward_command);
        let (occ, sub) = match fwd {
            Some(InterpretedForwardCommand::WalkForward) => (1u32, 0u32),
            Some(InterpretedForwardCommand::RunForward) => (2u32, 0u32),
            Some(InterpretedForwardCommand::Substate(cmd)) => (3u32, cmd & 0xffff),
            None => (0u32, 0u32),
        };
        out |= (occ & 0x3) << 4;
        out |= (sub & 0xffff) << 16;
        out
    }

    /// A3-D3 test seam: registry view.
    #[cfg(test)]
    pub(crate) fn movement_manager_for(&self, guid: Guid) -> Option<&MovementManager> {
        self.movement_managers.get(&guid)
    }

    /// A4/SA4F test seam: mutable registry view (enqueue fixtures for
    /// the per-entity `notify_animation_done_for` routing tests).
    #[cfg(test)]
    pub(crate) fn movement_manager_for_mut(&mut self, guid: Guid) -> Option<&mut MovementManager> {
        self.movement_managers.get_mut(&guid)
    }

    /// A13-W1 test seam: expose the last recorded server-control /
    /// force-position sequences so unit tests can assert the shared
    /// consumption helper actually recorded.
    #[cfg(test)]
    pub(crate) fn last_diagnostic_sequences(&self) -> (Option<u16>, Option<u16>, Option<u16>) {
        (
            self.sequence_diagnostics.last_server_control_sequence,
            self.sequence_diagnostics.last_force_position_sequence,
            self.sequence_diagnostics.last_teleport_sequence,
        )
    }

    fn should_send_stop_pulse(&self) -> bool {
        self.server_motion_active
    }

    fn note_server_motion_sent(&mut self, intent: ServerMotionIntent) {
        self.server_motion_active = true;
        self.last_server_motion_intent = Some(intent);
    }

    fn note_transient_motion_sent(&mut self) {
        self.server_motion_active = true;
        self.last_server_motion_intent = None;
    }

    fn note_server_motion_cleared(&mut self) {
        self.server_motion_active = false;
        self.last_server_motion_intent = None;
    }

    async fn execute_motion_state_at(
        &mut self,
        state: MotionState,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
        now: Instant,
    ) -> Result<Vec<WorldEvent>> {
        self.execute_motion_state_with_metadata_at(
            state,
            MovementPacketMetadata::default(),
            world,
            session,
            now,
        )
        .await
    }

    async fn execute_stop_at(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
        metadata: MovementPacketMetadata,
        had_active_local_motion: bool,
    ) -> Result<Vec<WorldEvent>> {
        let state_events = Vec::new();

        if self.should_send_stop_pulse() {
            log::info!(
                "movement: sending stop pulse (had_active_local_motion={}, server_motion_active={})",
                had_active_local_motion,
                self.server_motion_active,
            );
            Self::send_stop_pulse(world, session, metadata).await?;
            if had_active_local_motion {
                self.send_autonomous_position_sync(now, world, session, metadata)
                    .await?;
            }
            self.note_server_motion_cleared();
        }

        Ok(state_events)
    }

    async fn execute_motion_state_with_metadata_at(
        &mut self,
        state: MotionState,
        metadata: MovementPacketMetadata,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
        _now: Instant,
    ) -> Result<Vec<WorldEvent>> {
        let state_events = Vec::new();

        if self.should_send_motion_state_pulse(state, metadata.motion_style) {
            log::info!("movement: sending resolved motion pulse state={:?}", state);
            Self::send_motion_state_pulse(world, session, state, metadata).await?;
            self.motion_state_pulses_sent = self.motion_state_pulses_sent.wrapping_add(1);
            self.note_server_motion_sent(server_motion_intent(state, metadata.motion_style));
        }

        Ok(state_events)
    }

    async fn execute_transient_motion_at(
        &mut self,
        intent: TransientMotionIntent,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
    ) -> Result<()> {
        let movement_sequence = world.player.next_move_seq();
        let raw_motion_state = raw_motion_state_with_motion_style(
            world,
            RawMotionState {
                commands: vec![MotionItem::new(
                    intent.command,
                    movement_sequence,
                    true,
                    1.0,
                )],
                ..Default::default()
            },
            intent.motion_style,
        );
        Self::send_transient_motion_pulse(world, session, raw_motion_state).await?;
        self.note_transient_motion_sent();
        Ok(())
    }

    async fn execute_snap_facing(
        &mut self,
        now: Instant,
        desired_heading: f32,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
        metadata: MovementPacketMetadata,
    ) -> Result<Vec<WorldEvent>> {
        let normalized_heading = normalize_heading(desired_heading);
        let Some(current_pose) = world.local_player_runtime_pose() else {
            return Ok(Vec::new());
        };
        let current_heading = current_pose.rotation.to_heading();

        log::info!(
            "movement: snap facing from {:.3} rad to {:.3} rad",
            current_heading,
            normalized_heading,
        );

        if signed_heading_delta(current_heading, normalized_heading).abs() <= 1e-4 {
            return Ok(Vec::new());
        }

        let mut next_pos = current_pose;
        next_pos.rotation = Quaternion::from_heading(normalized_heading);
        let world_events = world.set_local_player_runtime_pose(next_pos);

        self.send_autonomous_position_sync(now, world, session, metadata)
            .await?;

        Ok(world_events)
    }

    async fn execute_arrival_pose(
        &mut self,
        now: Instant,
        pose: holtburger_common::position::WorldPosition,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
        metadata: MovementPacketMetadata,
    ) -> Result<Vec<WorldEvent>> {
        log::info!("movement: applying arrival pose {:?}", pose);

        let world_events = world.set_local_player_runtime_pose(pose);
        self.send_autonomous_position_sync(now, world, session, metadata)
            .await?;

        Self::send_stop_pulse(world, session, metadata).await?;
        self.note_server_motion_cleared();

        Ok(world_events)
    }

    async fn execute_autonomous_drive_intent(
        &mut self,
        intent: AutonomousDriveIntent,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
        now: Instant,
    ) -> Result<Vec<WorldEvent>> {
        let world_events = Vec::new();

        if let Some(state) = Self::autonomous_wire_motion_state(world, intent) {
            self.execute_motion_state_with_metadata_at(
                state,
                MovementPacketMetadata::default(),
                world,
                session,
                now,
            )
            .await?;

            return Ok(world_events);
        }

        if self.should_send_stop_pulse() {
            self.execute_stop_at(
                now,
                world,
                session,
                MovementPacketMetadata::default(),
                false,
            )
            .await?;
        }

        Ok(world_events)
    }

    /// Physics deep-dive 2026-06-01 (gap 4) — retail
    /// `CommandInterpreter::ShouldSendPositionEvent`
    /// (`acclient.c:718107-718141`) port for the heartbeat gate. Returns
    /// `true` when the pulse differs from the last one we sent: cell
    /// (landblock/objcell) changed, origin/heading moved beyond the pose
    /// epsilons, or the contact byte flipped (the contact-plane-change
    /// sub-branch). The first send (no prior pose) always passes.
    /// Retail `ShouldSendPositionEvent` change test, window-split
    /// (acclient.c:718121-718132). A cell/landblock change triggers in BOTH
    /// branches. PAST the 1s window (`past_window = true`) it tests
    /// `!Frame::is_equal` — origin + orientation; WITHIN the window it tests
    /// only the contact-plane (the wire `last_contact` byte, grounded vs
    /// airborne). This is the SEND-3/D1-POLL refinement: retail polls every
    /// tick and can emit a mid-window contact-plane-only re-send, where the
    /// prior boundary-only gate folded both branches together.
    fn autonomous_pose_changed(
        &self,
        pulse: &AutonomousPositionActionData,
        past_window: bool,
    ) -> bool {
        if !USE_AUTONOMOUS_POSITION_CHANGE_GATE {
            return true;
        }

        let Some(last_pose) = self.last_sent_autonomous_pose else {
            // No prior send to compare against: only the past-window (Frame)
            // branch establishes the first baseline send; the in-window
            // (contact-plane) branch stays quiet until that baseline exists,
            // so a steady held-run within the first interval doesn't emit a
            // spurious heartbeat before the window elapses.
            return past_window;
        };

        // Cell / landblock change (`objcell_id != last`) — both branches.
        if pulse.position.landblock_id != last_pose.landblock_id {
            return true;
        }

        if past_window {
            // Past the window: `!Frame::is_equal` — origin component. Same
            // landblock here, so a plain coords distance is the offset.
            if pulse.position.coords.distance(&last_pose.coords) > AUTONOMOUS_POSE_EPSILON_M {
                return true;
            }

            // `!Frame::is_equal` — orientation component.
            let heading_delta = signed_heading_delta(
                last_pose.rotation.to_heading(),
                pulse.position.rotation.to_heading(),
            );
            if heading_delta.abs() > AUTONOMOUS_POSE_HEADING_EPSILON_RAD {
                return true;
            }
        } else {
            // Within the window: contact-plane only. We don't carry a full
            // plane, but the wire `last_contact` byte (grounded vs airborne)
            // is the contact signal the server consumes; re-send when it
            // flips even if origin/orientation are otherwise unchanged.
            if self.last_sent_autonomous_contact != Some(pulse.last_contact) {
                return true;
            }
        }

        false
    }

    /// Record the pose + contact we just put on the wire so the next
    /// [`Self::autonomous_pose_changed`] compares against it.
    fn note_autonomous_position_sent(&mut self, pulse: &AutonomousPositionActionData) {
        self.last_sent_autonomous_pose = Some(pulse.position);
        self.last_sent_autonomous_contact = Some(pulse.last_contact);
    }

    async fn maybe_send_autonomous_position_heartbeat(
        &mut self,
        now: Instant,
        world: &WorldState,
        session: &mut dyn ActionSink,
        metadata: MovementPacketMetadata,
    ) -> Result<bool> {
        if !has_autonomous_position_sync_target(world) {
            self.clear_autonomous_position_heartbeat_schedule();
            return Ok(false);
        }

        // D1-POLL / SEND-3: retail polls ShouldSendPositionEvent EVERY tick
        // (acclient_2013 UseTime:699567) and branches on the 1s window. We poll
        // every movement tick too (the prior code early-returned until the 1s
        // boundary, collapsing retail's two branches and unable to emit a
        // mid-window contact-plane-only re-send). `past_window` is true once
        // the interval since the last send has elapsed; the window resets on
        // each send (refresh_..._schedule == retail last_sent_position_time).
        // MUST come after B1/D3-SNAP: continuous-poll re-asserts a drifted pose
        // more often, which the force-position snap (now shipped) converges.
        // ACE tolerates this cadence (ACE-CADENCE-1: no inbound anti-flood).
        //
        // On the first tick after acquiring a sync target, arm the window and
        // don't send yet: the first interval is a settle window (retail's
        // last_sent_position_time starts unset). Continuous-poll engages from
        // the next tick.
        let Some(next_heartbeat_at) = self.next_autonomous_position_heartbeat_at else {
            self.refresh_autonomous_position_heartbeat_schedule(now, world);
            return Ok(false);
        };
        let past_window = now >= next_heartbeat_at;

        // The heartbeat used to be gated on `IsPKType` (FastTick) because
        // our integrator emitted constant-Z poses that ACE physics
        // (`Player_Move.cs::HandleFallingDamage`) interpreted as the
        // player floating above terrain → applied false gravity →
        // impact damage on landing → death walking 10 s after a
        // Holtburg teleport (live-test reproduction 2026-05-08 against
        // tailnet1's Tester with PK status: "5 points of crushing
        // impact damage" → "10 points of massive impact damage" →
        // "You died!").
        //
        // The integrator now snaps pose Z to the cached terrain
        // heightmap before write-back (see
        // `advance_local_pose_for_manual_drive` + the
        // `WorldState::populate_terrain_heights` /
        // `terrain_height_at` cache), so the heartbeat carries a Z
        // that matches ACE's terrain. PK and NPK both fire the
        // heartbeat as before; the gate is no longer needed.

        let Some(pulse) = build_autonomous_position(world, metadata) else {
            self.clear_autonomous_position_heartbeat_schedule();
            return Ok(false);
        };

        // Physics deep-dive 2026-06-01 (gap 4) + D1-POLL: window-split
        // position-change gate (retail `ShouldSendPositionEvent`). Skip the
        // send when nothing meaningful changed for this window branch so we
        // don't re-assert a stale/drifted pose. On a skip we do NOT advance the
        // schedule — we keep polling every tick so the moment the pose
        // (past-window) or contact byte (in-window) changes, the next tick
        // sends, instead of waiting for the next 1s boundary.
        if !self.autonomous_pose_changed(&pulse, past_window) {
            return Ok(false);
        }

        session
            .send_action(GameAction::AutonomousPosition(Box::new(pulse.clone())))
            .await?;
        self.heartbeats_sent = self.heartbeats_sent.wrapping_add(1);
        self.note_autonomous_position_sent(&pulse);
        // Reset the 1s window from this send (retail last_sent_position_time):
        // the next interval is in-window (contact-plane only) before the
        // past-window (Frame) branch re-engages.
        self.refresh_autonomous_position_heartbeat_schedule(now, world);

        Ok(true)
    }

    pub(crate) async fn send_autonomous_position_sync(
        &mut self,
        now: Instant,
        world: &WorldState,
        session: &mut dyn ActionSink,
        metadata: MovementPacketMetadata,
    ) -> Result<bool> {
        let Some(pulse) = build_autonomous_position(world, metadata) else {
            self.clear_autonomous_position_heartbeat_schedule();
            return Ok(false);
        };

        // This is an explicit flush (arrival / drive sync), not the
        // throttled heartbeat — always send. Record the sent pose so
        // the next heartbeat's position-change gate compares against it.
        session
            .send_action(GameAction::AutonomousPosition(Box::new(pulse.clone())))
            .await?;
        self.note_autonomous_position_sent(&pulse);

        self.refresh_autonomous_position_heartbeat_schedule(now, world);

        Ok(true)
    }

    fn should_send_motion_state_pulse(
        &self,
        state: MotionState,
        motion_style: MotionStyle,
    ) -> bool {
        if !self.server_motion_active {
            return true;
        }

        self.last_server_motion_intent != Some(server_motion_intent(state, motion_style))
    }

    async fn send_motion_state_pulse(
        world: &WorldState,
        session: &mut dyn ActionSink,
        state: MotionState,
        metadata: MovementPacketMetadata,
    ) -> Result<()> {
        let data = build_move_to_state(
            world,
            build_motion_state_raw_motion_state(world, state, metadata.motion_style),
            metadata,
        );

        session
            .send_action(GameAction::MoveToState(Box::new(data)))
            .await
    }

    async fn send_transient_motion_pulse(
        world: &WorldState,
        session: &mut dyn ActionSink,
        raw_motion_state: RawMotionState,
    ) -> Result<()> {
        let data = build_move_to_state(world, raw_motion_state, MovementPacketMetadata::default());

        session
            .send_action(GameAction::MoveToState(Box::new(data)))
            .await
    }

    async fn send_stop_pulse(
        world: &WorldState,
        session: &mut dyn ActionSink,
        metadata: MovementPacketMetadata,
    ) -> Result<()> {
        let data = build_move_to_state(
            world,
            raw_motion_state_with_motion_style(
                world,
                RawMotionState::default(),
                metadata.motion_style,
            ),
            metadata,
        );

        session
            .send_action(GameAction::MoveToState(Box::new(data)))
            .await
    }
}

/// Wave-1 step 4 — the [`super::command_interpreter::InterpreterSeams`]
/// binding for the live `MovementSystem` (`?cmdInterp=on` lane). Borrows
/// the system + world while the interpreter itself is moved out (the
/// SC-15 borrow split); `drive` accumulates the per-axis
/// DoMotion/StopMotion stream into the ONE `MotionState` the rest of the
/// tick/pose/send machinery consumes.
///
/// Step-5 scoping (PLAN rows; what is LIVE vs still deferred):
/// - sends (row 9, LIVE step 5): `send_move_to_state` queues the
///   composed drive on `pending_cmd_interp_sends`; the tick flushes it
///   through the M1 converter and stamps `note_server_motion_sent`, so
///   the tick's edge-detector stays silent for key-driven edges (one
///   sender per edge). Non-key drive changes (FU-A use_time reclaims)
///   still ride the detector — the same send the legacy FU5 revival
///   produces (retail sends nothing on a use_time reclaim; the extra
///   pulse is the documented lane-shared divergence, benign to ACE).
/// - position-event reads (row 9 heartbeat half): stay stubbed —
///   the autonomous-position heartbeat REMAINS the tick's
///   (`maybe_send_autonomous_position_heartbeat`), per the PLAN's
///   "heartbeat cadence stays with the existing tick in wave 1".
///   `cur_time` stays 0.0 so the interpreter's windowed position gate
///   can never open (ONE heartbeat sender).
struct SystemInterpreterSeams<'a> {
    system: &'a mut MovementSystem,
    world: &'a mut WorldState,
    /// The tick's `now` — the jump-charge clock reads it (row 8:
    /// `commence_jump` → `jump_charge_commence(now, world)`).
    now: Instant,
    /// The composed effective drive (base = the pre-edge effective state;
    /// each dispatched motion rewrites ONE axis — retail
    /// `InterpretedMotionState::ApplyMotion` shape, acclient.c:332759).
    drive: MotionState,
    /// At least one motion was dispatched (the edge was not silent) — the
    /// caller installs `drive` as the active manual drive iff set.
    dispatched: bool,
}

impl SystemInterpreterSeams<'_> {
    /// Apply one dispatched motion to its axis slot
    /// (`InterpretedMotionState::ApplyMotion`, acclient.c:332759): the
    /// forward-slot commands own/clear the forward axis (Ready and
    /// releases clear); turn/sidestep never touch it; a non-locomotion
    /// substate press contributes zero locomotion.
    fn apply_axis(&mut self, cmd: u32, press: bool) {
        use super::motion_interp::{
            MOTION_READY, MOTION_RUN_FORWARD, MOTION_SIDESTEP_LEFT, MOTION_SIDESTEP_RIGHT,
            MOTION_TURN_LEFT, MOTION_TURN_RIGHT, MOTION_WALK_BACKWARDS, MOTION_WALK_FORWARD,
        };
        match cmd {
            MOTION_WALK_FORWARD | MOTION_RUN_FORWARD => {
                self.drive.forward = press.then_some(ForwardLocomotion::Forward);
            }
            MOTION_WALK_BACKWARDS => {
                self.drive.forward = press.then_some(ForwardLocomotion::Backstep);
            }
            MOTION_READY => {
                // The Ready reset press clears the forward slot.
                self.drive.forward = None;
            }
            MOTION_SIDESTEP_RIGHT => {
                self.drive.sidestep = press.then_some(SidestepLocomotion::StrafeRight);
            }
            MOTION_SIDESTEP_LEFT => {
                self.drive.sidestep = press.then_some(SidestepLocomotion::StrafeLeft);
            }
            MOTION_TURN_RIGHT => {
                self.drive.turning = press.then_some(Turn::Right);
            }
            MOTION_TURN_LEFT => {
                self.drive.turning = press.then_some(Turn::Left);
            }
            _ if cmd & 0x4000_0000 != 0 => {
                // A stored substate (gesture/crouch/…) owns the forward
                // slot at ZERO locomotion (FU6).
                if press {
                    self.drive.forward = None;
                }
            }
            _ => {}
        }
    }
}

impl super::command_interpreter::InterpreterSeams for SystemInterpreterSeams<'_> {
    fn cur_time(&self) -> f64 {
        0.0 // heartbeat cadence stays with the tick this wave (row 9)
    }
    fn do_motion(&mut self, cmd: u32, _params: &MovementParameters) -> u32 {
        // Retail `CPhysicsObj::DoMotion` stamps the autonomy latch
        // (:317325) — row 1: this seam is the lane's only latch raiser.
        self.system.last_move_was_autonomous = true;
        self.apply_axis(cmd, true);
        self.dispatched = true;
        0
    }
    fn stop_motion(&mut self, cmd: u32, _params: &MovementParameters) {
        self.system.last_move_was_autonomous = true; // :317364
        self.apply_axis(cmd, false);
        self.dispatched = true;
    }
    fn phys_stop_completely(&mut self) {
        // `CPhysicsObj::StopCompletely(player, 1)` — all movement stops;
        // the reclaim's ApplyCurrentMovement re-owns the slots right after.
        self.drive = MotionState {
            gait: self.drive.gait,
            ..MotionState::default()
        };
        self.dispatched = true;
    }
    fn stop_interpolating(&mut self) {
        // The FU-A leash drop — the SAME WorldState calls the legacy
        // lane's consume_pending_take_control makes (row 2): control
        // returns to the player and the interpolation queue stops (the
        // leash constraint itself survives — disarm is UnConstrain only).
        self.world.scene.set_local_server_controlled(false);
        self.world.stop_local_player_interpolation();
    }
    fn set_latch(&mut self) {
        self.system.last_move_was_autonomous = true; // :716946
    }
    fn minterp_set_hold_run(&mut self, effective_run: bool) {
        use crate::client::movement_types::Gait;
        self.drive.gait = if effective_run { Gait::Run } else { Gait::Walk };
        // Retail `SetHoldRun` under autonomy applies to the minterp
        // IMMEDIATELY (:716995-996) — the gait change must install even
        // when the edge dispatches no motion (a bare Shift edge), so the
        // session counts as dispatched. Found by the step-5 live A/B
        // smoke: without this, the Shift walk-gait was dropped and W
        // kept the Run gait (`cmd_interp_hold_run_edge_installs_gait`).
        self.dispatched = true;
    }
    fn minterp_is_standing_still(&self) -> bool {
        self.drive.is_locomotion_idle() && self.drive.turning.is_none()
    }
    fn player_forward_command(&self) -> Option<u32> {
        None // local player death routes through the wire lane; never Dead here
    }
    fn player_has_interp_motion_state(&self) -> bool {
        true
    }
    fn player_has_raw_motion_state(&self) -> bool {
        true
    }
    fn player_motions_pending(&self) -> bool {
        // Post-flip wave (2026-07-03) — the REAL retail gate:
        // `CMotionInterp::motions_pending` (acclient.c:343728), read off
        // the local REGISTRY minterp, whose queue the retail
        // move_to_interpreted_state body now FILLS on every wire stomp
        // (gesture substates/windup actions → 1-anim nodes) and the
        // completion-clock shim / renderer notify DRAINS
        // (`motion_table_manager.rs` module doc — the shim guarantees
        // drainage, so gating here can no longer wedge). The step-5
        // latch proxy (`!last_move_was_autonomous`) is RETIRED: it kept
        // FU-A dormant forever after ANY server-authored motion until a
        // fresh manual edge; the real queue releases the gate when the
        // gesture's authored length elapses — the retail post-anim
        // reclaim of held keys.
        //
        // Two carriers retail doesn't have, kept deliberately: the
        // server-MoveTo projection window and the pose-interpolation
        // stream are OUR directive-stream representations (retail
        // expresses directives through is_moving_to + TakeControl,
        // which the scene mirror only partially carries this wave —
        // see the wire-side control migration follow-up).
        let guid = self.world.player.guid;
        (guid != Guid::NULL
            && self
                .system
                .movement_managers
                .get(&guid)
                .is_some_and(|manager| manager.moveto_motions_pending()))
            || self.system.server_controlled_projection.is_some()
            || self.world.scene.local_player_is_interpolating()
    }
    fn player_is_moving_to(&self) -> bool {
        // Real predicate (step 5): the local registry manager's MoveTo
        // driver OR the server-MoveTo projection window.
        let guid = self.world.player.guid;
        (guid != Guid::NULL
            && self
                .system
                .movement_managers
                .get(&guid)
                .is_some_and(|manager| manager.is_moveto_active()))
            || self.system.server_controlled_projection.is_some()
    }
    fn local_cast_forward_lock_active(&self) -> bool {
        // WS04 (?castHoldReclaim) — the forward lock: flag on + a known
        // local cast chain in flight (JS-stamped) + grounded. The
        // `!is_airborne` gate yields the retail jump reset (LeaveGround
        // re-applies held movement, acclient.c:344457/:344484): a jump
        // mid-cast clears the lock for the airborne window and the landing
        // revives held-W. Default OFF ⇒ always false ⇒ byte-identical to
        // today when the flag is off.
        self.system.cast_hold_reclaim_enabled()
            && self.system.local_cast_window_active
            && !self.world.player.is_airborne
    }
    fn player_report_exhaustion(&mut self) {}
    fn player_turn_to_heading(&mut self, _params: &MovementParameters) {
        // command_turn_to_heading is unwired this wave (server/UI turn
        // requests ride the MoveTo driver lane).
    }
    fn player_position_event_ready(&self) -> bool {
        false // heartbeat stays with the tick (row 9)
    }
    fn player_objcell_id(&self) -> u32 {
        0
    }
    fn player_frame_equals(&self, _last: &super::command_interpreter::FrameView) -> bool {
        true
    }
    fn player_contact_plane_equals(&self, _last: &super::command_interpreter::PlaneView) -> bool {
        true
    }
    fn player_position_view(&self) -> super::command_interpreter::PositionView {
        super::command_interpreter::PositionView::default()
    }
    fn player_contact_plane_view(&self) -> super::command_interpreter::PlaneView {
        super::command_interpreter::PlaneView::default()
    }
    fn ui_toggles_run(&self) -> bool {
        // M7: holtburger is run-by-default with Shift=walk — exactly
        // ToggleRun==true; constant until a player-options store exists.
        true
    }
    fn use_mouse_turning(&self) -> bool {
        false // M4: no mouse-look consumer yet
    }
    fn combat_abort_automatic_attack(&mut self) {
        // No client-side combat system exists — the presence gate is
        // permanently closed (P09 pre-hook, impl-side no-op).
    }
    fn commence_jump(&mut self) {
        // Row 8 LIVE (step 5): the interpreter's OnAction case-8 press
        // routes onto the ONE charge clock (zero new clocks). A
        // press-time refusal keeps legacy parity semantics (the charge
        // simply does not arm); surfacing rides the step-5.5 event
        // stream.
        if let Err(refusal) = self.system.jump_charge_commence(self.now, self.world) {
            // Same kind-56 toast the legacy JumpChargeCommence arm
            // surfaces (retail press-time scroll text,
            // acclient.c:408050-408059).
            self.system
                .cmd_interp_events
                .push(CmdInterpEvent::JumpRefused(refusal as u32));
        }
    }
    fn do_jump(&mut self, autonomous: bool) {
        if autonomous {
            // Row 8 LIVE: queue the release for the tick's async flush
            // (`execute_jump_release` sends the Jump pack — seams are
            // sync). Retail: OnAction case-8 release → DoJump(1).
            self.system.pending_cmd_interp_jump_release = true;
        } else {
            // The non-autonomous arm is the dead ADJ-6 server-piloted
            // path (autonomy pinned at 2).
            log::debug!("cmdInterp: DoJump(non-autonomous) suppressed (ADJ-6)");
        }
    }
    fn finish_jump(&mut self) {
        // Row 8 LIVE: the blur/lose-control analog — drop the charge +
        // standstill root without jumping (retail FinishJump,
        // acclient.c:435853-435863).
        self.system.jump_charge_abort(self.world);
    }
    fn send_move_to_state(&mut self) -> bool {
        // Row 9 LIVE (step 5): queue the composed drive for the tick's
        // async flush (seams are sync, `Session::send_action` is not).
        // Retail cadence: every SendMovementEvent that passes its
        // guards emits ONE MoveToState — including an action command's
        // stop_completely + terminal pair. Returning true lets the
        // interpreter stamp its cadence bookkeeping.
        self.system.pending_cmd_interp_sends.push(self.drive);
        true
    }
    fn send_autonomous_position(&mut self) -> bool {
        false
    }
    fn send_autonomy_level(&mut self, _level: u32) {}
    fn send_do_movement(&mut self, cmd: u32, _speed: f32, _hold_key: u32) {
        // ADJ-6 dead arm (opcode 0xF61E disabled; autonomy pinned at 2).
        log::debug!("cmdInterp: legacy SendDoMovementEvent({cmd:#x}) suppressed (ADJ-6)");
    }
    fn send_stop_movement(&mut self, cmd: u32, _hold_key: u32) {
        log::debug!("cmdInterp: legacy SendStopMovementEvent({cmd:#x}) suppressed (ADJ-6)");
    }
    fn display_movement_error(&mut self, err: super::command_interpreter::MovementError) {
        log::info!("cmdInterp: movement refusal {err:?}");
    }
    fn display_autorun_status(&mut self, on: bool) {
        log::info!("cmdInterp: AutoRun {}", if on { "ON" } else { "OFF" });
    }
}

#[cfg(test)]
mod tests;
