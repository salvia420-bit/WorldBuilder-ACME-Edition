use super::common::{
    AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL, HUGE_QUANTUM, MAX_QUANTUM, MAX_VELOCITY, MIN_QUANTUM,
    PLAYER_GROUND_FRICTION_PER_SEC, PLAYER_GROUND_FRICTION_RETAIL,
    PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ, PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC,
    build_autonomous_position, build_motion_state_raw_motion_state, calc_friction,
    encode_contact_long_jump, has_autonomous_position_sync_target, local_omega_for_state,
    local_velocity_for_state, normalize_heading, raw_motion_state_with_motion_style,
    signed_heading_delta,
};
use super::motion_interp::interpreted_velocity_for_state;
use crate::client::movement_types::{
    AutonomousDriveIntent, ForwardLocomotion, MotionState, MotionStyle, MovementPacketMetadata,
    PlayerDriveIntent, Turn,
};
use anyhow::Result;
use holtburger_common::sequence::is_newer_u16;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::game_action::*;
use holtburger_protocol::messages::game_message::RawMotionState;
use holtburger_protocol::messages::movement::{InterpretedMotionCommand, MotionItem};
use holtburger_session::Session;
use holtburger_world::SolveBodyInput;
use holtburger_world::spatial::{InterpStep, LocalDriveControl, LocalDriveGait};
use holtburger_world::{SpatialBodyId, WorldEvent, WorldState};
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
/// legacy fallback). NOTE: this slice lands the SAVE/CLEAR bookkeeping
/// ONLY — the restore → precipice-slide re-attempt consumer is a
/// documented follow-on that requires the CTransition substep / contact-
/// plane state we do not yet have (see `USE_CLIFF_SLIDE` Stage-2). Until
/// that consumer lands, flipping this flag on only populates and clears a
/// field nobody reads (still behaviourally inert).
const USE_PRECIPICE_SLIDE_REENTRY: bool = false;

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
const USE_CLIFF_SLIDE: bool = false;

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
const USE_RETAIL_GROUND_FRICTION: bool = false;

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
const USE_TERRAIN_WALKABLE_GATE: bool = false;

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
const USE_WATER_COLLISION: bool = false;

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
const USE_PHYSICS_BSP: bool = false;

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
const USE_STATIC_BSP: bool = false;

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
const USE_OUTDOOR_WALL_NORMALS: bool = false;

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
                if let Some(seam_slide) =
                    holtburger_world::spatial::cliff_slide_residual_along_seam(
                        residual, normal, n_last,
                    )
                {
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
    let n_xy_len = (terrain_normal.x * terrain_normal.x
        + terrain_normal.y * terrain_normal.y)
        .sqrt();
    if n_xy_len < 1e-6 {
        return None;
    }
    let contour_wall = Vector3 {
        x: terrain_normal.x / n_xy_len,
        y: terrain_normal.y / n_xy_len,
        z: 0.0,
    };
    let slide =
        holtburger_world::spatial::slide_residual_along_wall_tangent(lateral, contour_wall);
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
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum QueuedDriveCommand {
    ManualSet(MotionState),
    ManualPulse {
        state: MotionState,
        duration: Duration,
    },
    Autonomous(AutonomousDriveIntent),
    Transient(TransientMotionIntent),
    ArriveAtPose {
        pose: holtburger_common::position::WorldPosition,
    },
    SnapFacing {
        heading: f32,
    },
    Stop,
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
        }
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

    fn ingest_drive_command(&mut self, command: QueuedDriveCommand, now: Instant) {
        match command {
            QueuedDriveCommand::ManualSet(state) => {
                self.active_drive = Some(ActiveDriveState::manual(state, None));
            }
            QueuedDriveCommand::ManualPulse { state, duration } => {
                self.active_drive = Some(ActiveDriveState::manual(state, Some(now + duration)));
            }
            QueuedDriveCommand::Autonomous(intent) => {
                self.active_drive = Some(ActiveDriveState::autonomous(intent));
            }
            QueuedDriveCommand::Transient(intent) => {
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
                self.pending_arrival_pose = None;
                self.pending_snap_facing = None;
                self.active_drive = None;
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
        let forward =
            (planar_delta.length_squared() > 1e-6).then_some(ForwardLocomotion::Forward);
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
        session: &mut Session,
    ) -> Result<Vec<WorldEvent>> {
        self.reconcile_server_controlled_projection(world, now);

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
        for command in queued {
            self.ingest_drive_command(command, now);
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
                None if had_active_manual_motion || explicit_stop_requested => {
                    events.extend(
                        self.execute_stop_at(
                            now,
                            world,
                            session,
                            MovementPacketMetadata::default(),
                            had_active_manual_motion || explicit_stop_requested,
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

        Some(LocalDriveControl {
            body_id,
            desired_world_delta: intent.desired_world_delta,
            desired_heading: intent.desired_heading,
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
    /// Gravity, friction (`pow(1-f, q)` composes correctly per-slice),
    /// the terminal-velocity clamp, and collision all run per slice,
    /// so a frame-hitch can no longer over-integrate a fall in one
    /// giant step. Gated behind
    /// [`USE_QUANTUM_SUBDIVIDED_INTEGRATION`] (default on); when off,
    /// the old single-step path is preserved for A/B.
    pub(crate) fn advance_local_pose_for_manual_drive(
        &self,
        world: &mut WorldState,
        dt: Duration,
    ) {
        if !USE_QUANTUM_SUBDIVIDED_INTEGRATION {
            // Legacy single-step path (pre-2026-06-01). Retained
            // behind the flag for A/B comparison of the subdivided
            // loop. Consumes the raw, unbounded `dt` in one step.
            self.advance_local_pose_for_manual_drive_slice(world, dt);
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

    /// One bounded integration slice (`quantum <= MAX_QUANTUM`).
    /// Factored out of [`advance_local_pose_for_manual_drive`] by the
    /// physics deep-dive 2026-06-01 quantum-subdivision work; the
    /// caller bounds and subdivides the incoming frame `dt` and feeds
    /// each slice here. The body is the original per-frame integrator
    /// (friction smoothing, lateral collision clamp, airborne gravity
    /// arc, floor-Z snap, rotation prediction) advanced by exactly one
    /// quantum.
    fn advance_local_pose_for_manual_drive_slice(
        &self,
        world: &mut WorldState,
        dt: Duration,
    ) {
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
            let threshold_sq = PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC
                * PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC;
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
            calc_friction(&mut v, contact_normal, velocity_mag2, friction, sledding, dt_s);
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
            for (cur, tgt) in [
                (&mut v.x, target_velocity.x),
                (&mut v.y, target_velocity.y),
            ] {
                let delta = tgt - *cur;
                let clamped = delta.clamp(-accel_step, accel_step);
                *cur += clamped;
            }
            // small-velocity snap (PhysicsObj.cpp:589-592).
            let mag_sq = v.x * v.x + v.y * v.y;
            let threshold_sq = PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC
                * PLAYER_VELOCITY_SNAP_THRESHOLD_M_PER_SEC;
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
            && let Some(outdoor) = world.scene.exited_envcell_to_outdoor(
                &pose,
                holtburger_world::spatial::PLAYER_CAPSULE_RADIUS,
            )
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
            let exclusion_aabbs =
                world.scene.open_door_exclusion_aabbs_near(&pose);
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
                let exit_room_relax = USE_LOCAL_ENVCELL_ENTRY
                    && !triangles.is_empty()
                    && world.scene.cell_has_outdoor_exit(cell_id);
                match cell_aabb_opt {
                    Some(aabb) if exclusion_aabbs.is_empty() && !exit_room_relax => {
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
                        let safe_t =
                            (hit.t - backoff / delta.length().max(1e-6)).max(0.0);
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
                                            * (slide_hit.t
                                                - backoff / slide.length().max(1e-6))
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
                        && !(SKIP_PARENTED_ENTITY_COLLISION
                            && e.physics_parent_id.is_some())
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
                    let ceiling = feet_z + holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT;
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
                    holtburger_world::spatial::PLAYER_STEP_UP_HEIGHT,
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
            } else {
                pose.coords.z += raw_delta.z;
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
                if world.player.is_airborne {
                    // Airborne outdoor: snap only on landing (falling
                    // through the terrain plane). The terrain Z is the
                    // canonical floor — when ballistic integration
                    // takes us below it with downward velocity, that's
                    // the touchdown.
                    if world.player.vertical_velocity <= 0.0 && pose.coords.z <= z {
                        pose.coords.z = z;
                        world.player.land();
                    }
                } else if USE_WATER_COLLISION
                    && world.is_entirely_water_cell_at(global.x, global.y)
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
                    if let Some(slide) = world
                        .terrain_normal_at(global.x, global.y)
                        .and_then(|n| {
                            terrain_contour_slide(
                                Vector3 {
                                    x: pose.coords.x - entry_local_xy.0,
                                    y: pose.coords.y - entry_local_xy.1,
                                    z: 0.0,
                                },
                                n,
                            )
                        })
                    {
                        // Local deltas equal global deltas (the landblock
                        // offset is a pure translation).
                        let cand_local =
                            (entry_local_xy.0 + slide.x, entry_local_xy.1 + slide.y);
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
                        match holtburger_world::spatial::step_down_decision(
                            pose.coords.z,
                            z,
                            holtburger_world::spatial::PLAYER_STEP_DOWN_HEIGHT,
                        ) {
                            holtburger_world::spatial::StepDownOutcome::Snap(snap_z) => {
                                pose.coords.z = snap_z;
                                // Walkable step-down resolved — clear the
                                // backup pose (no re-entry needed).
                                if USE_PRECIPICE_SLIDE_REENTRY {
                                    world.player.backup_pose_for_step_down = None;
                                }
                            }
                            holtburger_world::spatial::StepDownOutcome::Fall => {
                                world.player.begin_fall();
                                // Leave Z alone — gravity drops us next tick.
                                // Genuine ledge fall resolved — clear the
                                // backup pose.
                                if USE_PRECIPICE_SLIDE_REENTRY {
                                    world.player.backup_pose_for_step_down = None;
                                }
                            }
                        }
                    } else if pose.coords.z - z > LEDGE_FALL_THRESHOLD_M {
                        world.player.begin_fall();
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
                        pose.coords.z = snap_z;
                        // Indoor landing: snap-up triggered while
                        // airborne → touchdown. Outdoor analog above
                        // uses `world.player.land()` likewise.
                        if world.player.is_airborne {
                            world.player.land();
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
                        match holtburger_world::spatial::step_down_decision(
                            pose.coords.z,
                            snap_z,
                            holtburger_world::spatial::PLAYER_STEP_DOWN_HEIGHT,
                        ) {
                            holtburger_world::spatial::StepDownOutcome::Snap(z) => {
                                pose.coords.z = z;
                            }
                            holtburger_world::spatial::StepDownOutcome::Fall => {
                                world.player.begin_fall();
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
                let ceiling_z =
                    aabb.max.z - holtburger_world::spatial::PLAYER_CAPSULE_HEIGHT;
                // `floor_min` keeps the ceiling clamp from shoving the
                // player below the floor. Prefer the real per-poly
                // floor; otherwise the AABB lower bound. Matches the
                // legacy `floor_z.unwrap_or(aabb.min.z + 0.005)` (the
                // raw floor value, no headroom, exactly as before).
                let floor_min = poly_floor_z
                    .or(aabb_floor_z)
                    .unwrap_or(aabb.min.z + 0.005);
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
        let max_speed = capabilities.resolved_manual_run_speed() * 2.0;
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
            match world.scene.step_force_position_interpolation(
                body_id, dt_s, max_speed, on_contact,
            ) {
                InterpStep::Progressed { mut pose }
                | InterpStep::Completed { mut pose } => {
                    pose.coords.z = snapped_z;
                    pose
                }
                _ => pose,
            }
        } else {
            pose
        };

        let _ = world.set_local_player_runtime_pose(pose);
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
        session: &mut Session,
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
        session: &mut Session,
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
        session: &mut Session,
        _now: Instant,
    ) -> Result<Vec<WorldEvent>> {
        let state_events = Vec::new();

        if self.should_send_motion_state_pulse(state, metadata.motion_style) {
            log::info!("movement: sending resolved motion pulse state={:?}", state);
            Self::send_motion_state_pulse(world, session, state, metadata).await?;
            self.note_server_motion_sent(server_motion_intent(state, metadata.motion_style));
        }

        Ok(state_events)
    }

    async fn execute_transient_motion_at(
        &mut self,
        intent: TransientMotionIntent,
        world: &mut WorldState,
        session: &mut Session,
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
        session: &mut Session,
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
        session: &mut Session,
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
        session: &mut Session,
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
        session: &mut Session,
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
        session: &mut Session,
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
        session: &mut Session,
        state: MotionState,
        metadata: MovementPacketMetadata,
    ) -> Result<()> {
        let data = holtburger_protocol::messages::game_action::MoveToStateActionData {
            raw_motion_state: build_motion_state_raw_motion_state(
                world,
                state,
                metadata.motion_style,
            ),
            position: world.local_player_runtime_pose().unwrap_or_default(),
            instance_sequence: world.player.instance_sequence,
            server_control_sequence: world.player.server_control_sequence,
            teleport_sequence: world.player.teleport_sequence,
            force_position_sequence: world.player.force_position_sequence,
            contact_long_jump: encode_contact_long_jump(world, metadata),
        };

        session
            .send_action(GameAction::MoveToState(Box::new(data)))
            .await
    }

    async fn send_transient_motion_pulse(
        world: &WorldState,
        session: &mut Session,
        raw_motion_state: RawMotionState,
    ) -> Result<()> {
        let data = MoveToStateActionData {
            raw_motion_state,
            position: world.local_player_runtime_pose().unwrap_or_default(),
            instance_sequence: world.player.instance_sequence,
            server_control_sequence: world.player.server_control_sequence,
            teleport_sequence: world.player.teleport_sequence,
            force_position_sequence: world.player.force_position_sequence,
            contact_long_jump: encode_contact_long_jump(world, MovementPacketMetadata::default()),
        };

        session
            .send_action(GameAction::MoveToState(Box::new(data)))
            .await
    }

    async fn send_stop_pulse(
        world: &WorldState,
        session: &mut Session,
        metadata: MovementPacketMetadata,
    ) -> Result<()> {
        let data = holtburger_protocol::messages::game_action::MoveToStateActionData {
            raw_motion_state: raw_motion_state_with_motion_style(
                world,
                RawMotionState::default(),
                metadata.motion_style,
            ),
            position: world.local_player_runtime_pose().unwrap_or_default(),
            instance_sequence: world.player.instance_sequence,
            server_control_sequence: world.player.server_control_sequence,
            teleport_sequence: world.player.teleport_sequence,
            force_position_sequence: world.player.force_position_sequence,
            contact_long_jump: encode_contact_long_jump(world, metadata),
        };

        session
            .send_action(GameAction::MoveToState(Box::new(data)))
            .await
    }
}

#[cfg(test)]
mod tests;
