//! A3-D3 (2026-06-12, unified movement pipeline STAGE 3) —
//! `MoveToManager`: the retail per-frame MoveTo DRIVER (the "base
//! Stage-3 driver" the S6 skeleton deferred). Declarations mirror
//! retail (`~/ac-headers/acclient.c:7129-7161`; bodies at
//! `:344715-346240`; ACE `Physics/Managers/MoveToManager.cs` is 1:1).
//! House pure-return style: [`MoveToManager::use_time`] consumes a
//! [`MoveToView`] and returns a [`MoveToDriveOutput`] — it never
//! touches the world, the lattice, or the wire. The FACADE
//! (`MovementManager::use_time_moveto`) applies the
//! `_DoMotion`/`_StopMotion` requests through the landed
//! `CMotionInterp` lattice, and the `MovementSystem` tick shim
//! (gated [`USE_MOVETO_DRIVER`], LOCAL player only) translates the
//! steering output into the existing autonomous-drive lane — ZERO new
//! send sites (A13 single-send boundary), and NEVER a TurnToEvent
//! 0xF649 (S15 NO-GO, RULINGS item 5).
//!
//! Heading domain: the retail math is DEGREES with a `0.0002` epsilon
//! (`heading_diff`/`heading_greater`/`get_command`, params.rs ports).
//! Our poses carry radians — the conversion happens at ONE boundary
//! (the `self_heading_deg` / `heading_deg_between` helpers below);
//! [`MoveToDriveOutput::set_heading`] is returned in RADIANS for the
//! shim's snap path.

use super::motion_interp::{
    MOTION_RUN_FORWARD, MOTION_TURN_LEFT, MOTION_TURN_RIGHT, MOTION_WALK_BACKWARDS,
    MOTION_WALK_FORWARD,
};
use super::params::{HEADING_EPSILON_DEG, MovementParameters, heading_diff, heading_greater};
use holtburger_common::Guid;
use holtburger_common::position::WorldPosition;
use holtburger_protocol::messages::movement::messages::motion::Origin;
use std::collections::VecDeque;
use web_time::Instant;

/// A3-D3 driver gate (2026-06-12, SD3D spec §4). Gates ONLY the
/// `MovementSystem` tick shim (the LOCAL-player driver loop) — the
/// pure state machine below ships ungated and is inert without the
/// shim (nothing else calls `use_time` with a view; the `_ungated`
/// house pattern). Reachability coupling (url-flags.md §6): wire-lane
/// directives flow only under `USE_UNPACK_MOVEMENT_SEMANTICS`
/// (+ `?wireStatePacks=stage1` on wasm); the S10 `?wasmPursuit=on`
/// input lane flows independently — the driver serves both. Rust
/// const: flipping means editing this source + wasm rebuild. NO new
/// wasm exports ride this item (manifest stays v4).
///
/// M5 double-driver containment (spec §7 Q1, resolved by grep at
/// implementation time): the legacy local-player TurnTo lanes need NO
/// gate — (a) the `handlers/movement.rs` heading-set only mutates the
/// ENTITY record, never the runtime pose the local rig renders from;
/// (b) the JS KIND_TURN ease already skips the local guid
/// (`!isLocalPlayerGuid(turnGuid)`, loop.js:2195/:2563). Remote
/// entities never enter the shim (F3-2/A2 territory).
pub(crate) const USE_MOVETO_DRIVER: bool = true;

/// The retail "already at target distance" walk band (degrees domain
/// epsilon shared with the heading math — `0.00019999999`,
/// acclient.c:344740 et al.) re-exported for the driver tests.
pub(crate) const MOVETO_EPSILON: f32 = HEADING_EPSILON_DEG;

/// `Position::cylinder_distance(r1, h1, p1, r2, h2, p2)`
/// (acclient.c:467221-467266; ACE `Position.CylinderDistance`): the
/// radii/height-aware separation the UseSpheres (`0x400`) metric uses
/// — exactly F6-5's semantics. 3D center offset minus summed radii
/// for the lateral term; the vertical term measures the gap between
/// the cylinders' z-extents (`<= 0` = overlapping vertically).
pub(crate) fn cylinder_distance(
    r1: f32,
    h1: f32,
    p1: &WorldPosition,
    r2: f32,
    h2: f32,
    p2: &WorldPosition,
) -> f32 {
    let offset = p2.global_coords() - p1.global_coords();
    let reach = offset.length() - (r1 + r2);
    let (z1, z2) = (p1.coords.z, p2.coords.z);
    let dz = if z1 <= z2 {
        z2 - (z1 + h1)
    } else {
        z1 - (z2 + h2)
    };
    if dz <= 0.0 {
        if reach <= 0.0 {
            -(dz * dz + reach * reach).sqrt()
        } else {
            reach
        }
    } else if reach > 0.0 {
        (dz * dz + reach * reach).sqrt()
    } else {
        dz
    }
}

/// The stored movement directive — the `MovementStruct` 6-9 payloads
/// (`MoveToManager::{MoveToObject, MoveToPosition, TurnToObject,
/// TurnToHeading}`, acclient.c unpack cases 6-9). Shape coordinates
/// with A14-I2 (the input-intent seam consumes this entry shape —
/// ROADMAP §2 A2/A3 seam).
// (`Origin` is not `Copy` — protocol struct — so this is Clone-only.)
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MoveToDirective {
    /// Case 6 with a resolvable target (`CPhysicsObj::MoveToObject`,
    /// acclient.c:319767-319825). `object_radius`/`object_height` are
    /// the CALLER-resolved target physics dims (retail reads
    /// `CPartArray::GetRadius/GetHeight`, 0.0 fallback,
    /// acclient.c:319808-319817) — retail stores them as manager
    /// fields, NOT params (spec §3 contract resolution; params.rs
    /// stays a pure retail-ctor transcription). Retail's
    /// `top_level_id` is collapsed to the target guid (no part-owner
    /// hierarchy in our entity model — spec §7 Q5 fallback).
    MoveToObject {
        target: Guid,
        origin: Origin,
        object_radius: f32,
        object_height: f32,
        params: MovementParameters,
    },
    /// Case 7 — and the case-6 missing-target LABEL_15 fallback
    /// (`MoveToManager::MoveToPosition`, acclient.c:345790-345857).
    MoveToPosition {
        origin: Origin,
        params: MovementParameters,
    },
    /// Case 8 with a resolvable target (`CPhysicsObj::TurnToObject`,
    /// acclient.c:345242-345295).
    TurnToObject {
        target: Guid,
        params: MovementParameters,
    },
    /// Case 9 — and the case-8 missing-target fallback with
    /// `params.desired_heading` pre-set (acclient.c:345954-346016).
    TurnToHeading { params: MovementParameters },
}

/// The pending-action node list payloads — retail node types 9
/// (TurnToHeading, `AddTurnToHeadingNode` acclient.c:345096-345118)
/// and 7 (MoveToPosition, `AddMoveToPositionNode` :345120-345141).
/// Headings are DEGREES (retail wire/math domain).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum MoveToNode {
    TurnToHeading(f32),
    MoveToPosition,
}

/// The per-frame world snapshot the driver consumes (the house
/// pure-return pattern — mirror of `UnpackEffects`,
/// movement_manager.rs). Built by the `MovementSystem` shim each tick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MoveToView {
    /// Retail `transient_state & 1` gate (acclient.c:346024). Spec §7
    /// Q3 fallback: sourced from `!world.player.is_airborne` — the
    /// same bit the wire `last_contact` byte reads (system.rs
    /// `on_contact` site).
    pub on_walkable_contact: bool,
    /// Local pose (position + heading) — radians rotation; converted
    /// to degrees inside the driver (one boundary).
    pub self_pos: WorldPosition,
    /// Cylinder-metric self half (acclient.c:344877-344878).
    pub self_radius: f32,
    pub self_height: f32,
    /// Refreshed per tick by the shim — the client-side
    /// `HandleUpdateTarget` cadence (acclient.c:346051-346118).
    /// `None` while a targeted directive's pose is unresolved (the
    /// retail `initialized == 0` WAIT, :346030).
    pub target_pos: Option<WorldPosition>,
    /// `CMotionInterp::motions_pending` (motion_interp.rs:608 ↔
    /// acclient.c:343728).
    pub motions_pending: bool,
    /// Position-manager interpolation queue active
    /// (position_manager.rs `is_interpolating`).
    pub is_interpolating: bool,
    /// `CheckProgressMade` clock (acclient.c:344833).
    pub now: Instant,
}

/// Per-tick steering descriptor — what the shim feeds the autonomous
/// drive lane while a command is latched (the lane expires per tick,
/// so the driver re-supplies every frame; retail instead latches the
/// interpreted motion in the minterp).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum MoveToSteer {
    /// Walk command active: unit-forward toward `target` (negated
    /// when `away` — the get_command away arm walks forward facing
    /// away, acclient.c:346224-346239).
    Walk {
        target: WorldPosition,
        away: bool,
        run: bool,
    },
    /// Turn command active: face `heading_deg` (degrees, retail node
    /// domain).
    Turn { heading_deg: f32 },
}

/// The physics-domain effects one `use_time` returns instead of
/// performing inline (spec §3). `do_motions`/`stop_motions` are
/// `_DoMotion`/`_StopMotion` requests the FACADE routes through the
/// landed lattice (acclient.c:344753-344831).
///
/// DOCUMENTED DEVIATION from the spec sketch: `do_motions` is a `Vec`
/// (spec sketched `Option`) — retail can issue an aux-turn `_DoMotion`
/// AND a same-frame arrival-begin `_DoMotion` in one `UseTime`
/// (HandleMoveToPosition :345620-345651 then :345663-345686 →
/// BeginNextNode), and an `Option` would drop one.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct MoveToDriveOutput {
    /// `_DoMotion` requests (walk/turn commands + fresh params,
    /// CancelMoveTo bit stripped, acclient.c:345412-345414).
    pub do_motions: Vec<(u32, MovementParameters)>,
    /// `_StopMotion` requests (CleanUp/arrival stops,
    /// acclient.c:345148-345164).
    pub stop_motions: Vec<(u32, MovementParameters)>,
    /// HandleTurnToHeading arrival snap (acclient.c:345746) —
    /// RADIANS (converted at the output boundary for the shim's
    /// `pending_snap_facing` path).
    pub set_heading: Option<f32>,
    /// CleanUp/arrival/entry stop edge (acclient.c:345179-345180,
    /// :345190). The shim only emits a wire stop when no steering is
    /// active the same tick.
    pub stop_completely: bool,
    /// Sticky-bit arrival → `PositionManager::StickTo(target, radius,
    /// height)` (acclient.c:345553-345566).
    pub stick_to: Option<(Guid, f32, f32)>,
    /// Mirrors the completion latch for same-tick consumers (the
    /// read-clear latch itself is [`MoveToManager::take_completion`]).
    pub completion: Option<u32>,
    /// Per-tick steering re-supply for the autonomous-drive lane.
    pub steer: Option<MoveToSteer>,
}

fn origin_to_world(origin: &Origin) -> WorldPosition {
    WorldPosition {
        landblock_id: origin.cell_id,
        coords: origin.position,
        rotation: holtburger_common::Quaternion::identity(),
    }
}

/// Pose heading in DEGREES `[0, 360)` — the one radians→degrees
/// boundary (spec M1.3).
fn self_heading_deg(pos: &WorldPosition) -> f32 {
    pos.rotation.to_heading().to_degrees()
}

/// `Position::heading(from, to)` in DEGREES — retail heading-to-target.
fn heading_deg_between(from: &WorldPosition, to: &WorldPosition) -> f32 {
    from.heading_to(to).to_degrees()
}

/// The retail epsilon-fold + positive wrap applied to a raw heading
/// delta (acclient.c:345400-345405 and the twin sites).
fn fold_heading_delta(mut delta: f32) -> f32 {
    if delta.abs() < HEADING_EPSILON_DEG {
        delta = 0.0;
    }
    if delta < -HEADING_EPSILON_DEG {
        delta += 360.0;
    }
    delta
}

/// `MoveToManager` — directive slot + node walk + per-frame driver
/// state (`InitializeLocalVariables`, acclient.c:344913-344959).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MoveToManager {
    /// The active directive (retail `movement_type` + sought-target
    /// fields). `is_active` ⇔ `Some` (retail `is_moving_to` =
    /// `movement_type != 0`, acclient.c:344895-344898).
    directive: Option<MoveToDirective>,
    /// Last `CancelMoveTo(err)` code recorded (diagnostics).
    last_cancel_error: Option<u32>,
    /// S10 contract: read-clear completion latch. `Some(0)` = arrived
    /// (BeginNextNode empty queue, acclient.c:345544-345560);
    /// `Some(err)` = failure/abort (0x36 cancelled, 0x3D
    /// fail-distance, 0x37/0x38 target lost, 8 unresolvable). Retail
    /// drops the status client-side (`CleanUpAndCallWeenie` body
    /// :345171-345181 calls no weenie); the latch is our poll-shaped
    /// analog (spec §3 / S10 §6.5).
    completion: Option<u32>,
    /// A2-P3 "target-update plumbing" anchor — the wire-side
    /// `HandleUpdateTarget` record (the driver's own target refresh
    /// rides the per-tick [`MoveToView::target_pos`] instead).
    last_target_update: Option<(Guid, Origin)>,
    /// `HitGround` re-begin marker (acclient.c:345570-345574).
    pending_hit_ground_rebegin: bool,
    /// Retail entry `StopCompletely` request (MoveToObject :345190 /
    /// MoveToPosition :345798; TurnTo* only under the params bit
    /// 0x10000, :345248/:345966) — surfaced on the first driven
    /// frame's output (entries have no view; OQ8-adjacent deferral).
    pending_entry_stop: bool,
    // ---- per-frame driver state (InitializeLocalVariables) ----
    pending_nodes: VecDeque<MoveToNode>,
    /// Stored params copy of the active directive (retail
    /// `movement_params`, full 10-field copy at every entry).
    movement_params: MovementParameters,
    /// Stamped at the FIRST driven frame, not at entry (retail stamps
    /// from `physics_obj->m_position` at entry, acclient.c:345196 —
    /// ours has no pose at entry; spec §7 Q8 fallback: documented
    /// one-frame fail_distance baseline skew, bounded by one tick).
    starting_position: Option<WorldPosition>,
    current_target_position: Option<WorldPosition>,
    sought_object_radius: f32,
    sought_object_height: f32,
    previous_distance: f32,
    previous_distance_time: Option<Instant>,
    original_distance: f32,
    original_distance_time: Option<Instant>,
    previous_heading: f32,
    /// Bookkeeping ONLY — no threshold consumer exists in the decomp
    /// or ACE MoveToManager.cs (acclient.c:345657-345659 note).
    fail_progress_count: u32,
    current_command: u32,
    aux_command: u32,
    moving_away: bool,
    initialized: bool,
}

impl Default for MoveToManager {
    /// `InitializeLocalVariables` (acclient.c:344913-344959):
    /// `f32::MAX` distance seeds (`2139095039` bits = `0x7F7FFFFF`),
    /// everything else zeroed.
    fn default() -> Self {
        Self {
            directive: None,
            last_cancel_error: None,
            completion: None,
            last_target_update: None,
            pending_hit_ground_rebegin: false,
            pending_entry_stop: false,
            pending_nodes: VecDeque::new(),
            movement_params: MovementParameters::default(),
            starting_position: None,
            current_target_position: None,
            sought_object_radius: 0.0,
            sought_object_height: 0.0,
            previous_distance: f32::from_bits(0x7F7F_FFFF),
            previous_distance_time: None,
            original_distance: f32::from_bits(0x7F7F_FFFF),
            original_distance_time: None,
            previous_heading: 0.0,
            fail_progress_count: 0,
            current_command: 0,
            aux_command: 0,
            moving_away: false,
            initialized: false,
        }
    }
}

impl MoveToManager {
    /// `InitializeLocalVariables` analog for the driver slice —
    /// preserves the diagnostics/latch fields (`last_cancel_error`,
    /// `completion`, `last_target_update`) which have their own
    /// lifecycles.
    fn reset_driver_state(&mut self) {
        self.pending_nodes.clear();
        self.movement_params = MovementParameters::default();
        self.starting_position = None;
        self.current_target_position = None;
        self.sought_object_radius = 0.0;
        self.sought_object_height = 0.0;
        self.previous_distance = f32::from_bits(0x7F7F_FFFF);
        self.previous_distance_time = None;
        self.original_distance = f32::from_bits(0x7F7F_FFFF);
        self.original_distance_time = None;
        self.previous_heading = 0.0;
        self.fail_progress_count = 0;
        self.current_command = 0;
        self.aux_command = 0;
        self.moving_away = false;
        self.initialized = false;
        self.pending_entry_stop = false;
    }

    /// The CleanUp `_StopMotion` params: FRESH defaults carrying the
    /// stored hold key with the CancelMoveTo bit stripped
    /// (acclient.c:345148-345152; the Handle* twins :345600-345607
    /// additionally carry the stored speed — harmless here, included
    /// for parity with the begin-frame params).
    fn cleanup_params(&self) -> MovementParameters {
        let mut params = MovementParameters::default();
        params.bitfield &= !0x8000;
        params.hold_key_to_apply = self.movement_params.hold_key_to_apply;
        params.speed = self.movement_params.speed;
        params
    }

    /// `MoveToManager::MoveToObject` (acclient.c:345184-345240; decl
    /// :7145): store dims/params/directive, request the entry
    /// StopCompletely, and WAIT (`initialized = false`) for the first
    /// resolved target pose (the `HandleUpdateTarget` analog — the
    /// shim's per-tick `MoveToView::target_pos`). S10 §2.4 contract
    /// signature: the two f32 dims are caller-resolved (0.0/0.0 when
    /// unresolvable — the retail CPartArray-null fallback,
    /// acclient.c:319810-319815). `params.rs` stays untouched.
    pub(crate) fn move_to_object(
        &mut self,
        target: Guid,
        origin: Origin,
        object_radius: f32,
        object_height: f32,
        params: MovementParameters,
    ) {
        self.reset_driver_state();
        self.movement_params = params;
        self.sought_object_radius = object_radius;
        self.sought_object_height = object_height;
        self.pending_entry_stop = true;
        self.directive = Some(MoveToDirective::MoveToObject {
            target,
            origin,
            object_radius,
            object_height,
            params,
        });
    }

    /// `MoveToManager::MoveToPosition` (acclient.c:345790-345857) —
    /// sticky bit CLEARED (`bitfield &= 0xFFFFFF7F`, :345852). Retail
    /// builds the node list at entry from the live pose; ours defers
    /// the build to the first driven frame (no pose at entry — the
    /// same deliberate deferral as the OQ8 starting-position stamp).
    pub(crate) fn move_to_position(&mut self, origin: Origin, params: MovementParameters) {
        self.reset_driver_state();
        let mut stored = params;
        stored.bitfield &= !0x80;
        self.movement_params = stored;
        self.current_target_position = Some(origin_to_world(&origin));
        self.pending_entry_stop = true;
        self.directive = Some(MoveToDirective::MoveToPosition { origin, params });
    }

    /// `MoveToManager::TurnToObject` (acclient.c:345242-345295) —
    /// entry StopCompletely only under the params bit 0x10000
    /// (:345248); defers to the first resolved target pose
    /// (`TurnToObject_Internal`, :345911-345951).
    pub(crate) fn turn_to_object(&mut self, target: Guid, params: MovementParameters) {
        self.reset_driver_state();
        self.movement_params = params;
        self.pending_entry_stop = params.stop_completely();
        self.directive = Some(MoveToDirective::TurnToObject { target, params });
    }

    /// `MoveToManager::TurnToHeading` (acclient.c:345954-346016) —
    /// sticky cleared (:345990), conditional entry stop (:345966),
    /// one type-9 node (built on the first driven frame like the
    /// other entries; the heading needs no pose so the deferral is
    /// behavior-neutral).
    // A13-W4 TurnToEvent emit hook (design-gated, ROADMAP §8 row 2):
    // S15 ruled NO-GO — ACE has no 0xF649 handler (dead enum entry,
    // InboundMessageManager drops it), so NO send is wired here; heading
    // already flows server-ward via MoveToState 0xF61C +
    // AutonomousPosition 0xF753 only. Reopen only if upstream ACE adds
    // the handler.
    pub(crate) fn turn_to_heading(&mut self, params: MovementParameters) {
        self.reset_driver_state();
        let mut stored = params;
        stored.bitfield &= !0x80;
        self.movement_params = stored;
        self.pending_entry_stop = params.stop_completely();
        self.directive = Some(MoveToDirective::TurnToHeading { params });
    }

    /// `MoveToManager::CancelMoveTo(err)` (acclient.c:345297-345353):
    /// acts only while a movement is active (retail `movement_type !=
    /// 0` gate, :345303). Drains the node list, returns the CleanUp
    /// `_StopMotion` set + StopCompletely (spec M2: cancel returns the
    /// stop-effects struct so callers apply them synchronously,
    /// matching retail's inline `_StopMotion`), and latches the
    /// completion = `Some(error)` (S10 contract).
    pub(crate) fn cancel_moveto(&mut self, error: u32) -> MoveToDriveOutput {
        let mut out = MoveToDriveOutput::default();
        if self.directive.is_none() {
            return out;
        }
        self.cancel_into(error, &mut out);
        out.completion = self.completion;
        out
    }

    /// Shared cancel body (`CleanUp` :345143-345168 +
    /// `CleanUpAndCallWeenie` :345171-345181).
    fn cancel_into(&mut self, error: u32, out: &mut MoveToDriveOutput) {
        if self.directive.is_some() {
            self.last_cancel_error = Some(error);
            self.completion = Some(error);
        }
        let params = self.cleanup_params();
        if self.current_command != 0 {
            out.stop_motions.push((self.current_command, params));
        }
        if self.aux_command != 0 {
            out.stop_motions.push((self.aux_command, params));
        }
        out.stop_completely = true;
        out.steer = None;
        self.reset_driver_state();
        self.directive = None;
        self.pending_hit_ground_rebegin = false;
    }

    /// S10 contract: retail `is_moving_to` = `movement_type != 0`
    /// (acclient.c:344895-344898) — ours: directive slot occupied.
    pub(crate) fn is_active(&self) -> bool {
        self.directive.is_some()
    }

    /// S10 contract: read-clear completion latch (see the field doc).
    pub(crate) fn take_completion(&mut self) -> Option<u32> {
        self.completion.take()
    }

    /// `MoveToManager::HitGround` — retail re-begins the node chain on
    /// touchdown (`BeginNextNode` iff `movement_type`,
    /// acclient.c:345570-345574); the marker is consumed by the next
    /// driven frame.
    pub(crate) fn hit_ground(&mut self) {
        if self.directive.is_some() {
            self.pending_hit_ground_rebegin = true;
        }
    }

    /// `MoveToManager::HandleUpdateTarget` wire-record half
    /// (acclient.c:346051-346118) — the A2-P3 anchor. The driver's
    /// own target refresh rides [`MoveToView::target_pos`] per tick
    /// (the same cadence), with the type-6 progress-stamp reset
    /// applied change-gated inside [`Self::use_time`].
    #[allow(dead_code)] // staged: A2-P3 target-update plumbing (W5)
    pub(crate) fn handle_update_target(&mut self, target: Guid, origin: Origin) {
        self.last_target_update = Some((target, origin));
    }

    /// Active directive view (tests + S10's typed-entry diagnostics).
    #[allow(dead_code)] // runtime readers go through directive_target/is_active
    pub(crate) fn directive(&self) -> Option<&MoveToDirective> {
        self.directive.as_ref()
    }

    /// The targeted directive's guid (shim target-refresh input).
    pub(crate) fn directive_target(&self) -> Option<Guid> {
        match self.directive.as_ref()? {
            MoveToDirective::MoveToObject { target, .. }
            | MoveToDirective::TurnToObject { target, .. } => Some(*target),
            _ => None,
        }
    }

    /// Diagnostics: last recorded cancel error.
    #[allow(dead_code)] // diagnostics (tests today)
    pub(crate) fn last_cancel_error(&self) -> Option<u32> {
        self.last_cancel_error
    }

    /// Whether a `HitGround` re-begin is owed (driver input).
    #[allow(dead_code)] // diagnostics (tests today)
    pub(crate) fn pending_hit_ground_rebegin(&self) -> bool {
        self.pending_hit_ground_rebegin
    }

    /// A2-P3 anchor view.
    #[allow(dead_code)] // staged: A2-P3 target-update consumer (W5)
    pub(crate) fn last_target_update(&self) -> Option<&(Guid, Origin)> {
        self.last_target_update.as_ref()
    }

    /// `GetCurrentDistance` (acclient.c:344856-344893): UseSpheres
    /// `0x400` → [`cylinder_distance`]; else point distance. DEFAULT
    /// params have 0x400 SET (`0x1EE0F`) — cylinder is the default
    /// metric (F6-5 parity).
    fn current_distance(&self, view: &MoveToView) -> f32 {
        let Some(target) = self.current_target_position.as_ref() else {
            return f32::from_bits(0x7F7F_FFFF);
        };
        if self.movement_params.use_spheres() {
            cylinder_distance(
                view.self_radius,
                view.self_height,
                &view.self_pos,
                self.sought_object_radius,
                self.sought_object_height,
                target,
            )
        } else {
            view.self_pos.distance_to(target)
        }
    }

    /// `CheckProgressMade` (acclient.c:344833-344854): inside the 1 s
    /// window → always true; past it, the previous-stamp rate AND the
    /// original-stamp rate must both reach 0.25 units/s. The previous
    /// stamps refresh ONLY when the first rate passes (the retail `||`
    /// short-circuit).
    fn check_progress_made(&mut self, curr_distance: f32, now: Instant) -> bool {
        let Some(prev_time) = self.previous_distance_time else {
            self.previous_distance = curr_distance;
            self.previous_distance_time = Some(now);
            return true;
        };
        let elapsed = now.saturating_duration_since(prev_time).as_secs_f32();
        if elapsed <= 1.0 {
            return true;
        }
        let delta = if self.moving_away {
            curr_distance - self.previous_distance
        } else {
            self.previous_distance - curr_distance
        };
        if delta / elapsed < 0.25 {
            return false;
        }
        self.previous_distance = curr_distance;
        self.previous_distance_time = Some(now);
        let original_delta = if self.moving_away {
            curr_distance - self.original_distance
        } else {
            self.original_distance - curr_distance
        };
        let original_elapsed = self
            .original_distance_time
            .map(|t| now.saturating_duration_since(t).as_secs_f32())
            .unwrap_or(elapsed)
            .max(f32::EPSILON);
        original_delta / original_elapsed >= 0.25
    }

    /// Type-6 target-update stamp reset (acclient.c:346094-346101) —
    /// applied change-gated (retail resets on every TargetInfo event,
    /// which arrives at target-movement cadence; our per-tick pose
    /// refresh would otherwise reset every frame and neuter
    /// `CheckProgressMade` — documented adaptation).
    fn refresh_moveto_target(&mut self, target_pos: WorldPosition, now: Instant) {
        let moved = self
            .current_target_position
            .map(|prev| prev.distance_to(&target_pos) > 0.05)
            .unwrap_or(true);
        if moved {
            self.current_target_position = Some(target_pos);
            self.previous_distance = f32::from_bits(0x7F7F_FFFF);
            self.previous_distance_time = Some(now);
            self.original_distance = f32::from_bits(0x7F7F_FFFF);
            self.original_distance_time = Some(now);
        }
    }

    /// `MoveToObject_Internal` / `MoveToPosition` node build
    /// (acclient.c:345859-345909 / :345790-345857): heading-to-target
    /// node + MoveToPosition node when `get_command` probes a command;
    /// UseFinalHeading `0x40` → trailing heading node with the
    /// `desired_heading` offset fmod 360 (:345893-345901 — for the
    /// position form the trailing node is the absolute
    /// `desired_heading`, :345835-345836).
    fn build_move_nodes(&mut self, view: &MoveToView, target: WorldPosition, absolute_final: bool) {
        self.current_target_position = Some(target);
        let heading_to_target = heading_deg_between(&view.self_pos, &target);
        let distance = self.current_distance(view);
        let delta = fold_heading_delta(heading_to_target - self_heading_deg(&view.self_pos));
        let (command, _, _) = self.movement_params.get_command(distance, delta);
        if command.is_some() {
            self.pending_nodes
                .push_back(MoveToNode::TurnToHeading(heading_to_target));
            self.pending_nodes.push_back(MoveToNode::MoveToPosition);
        }
        if self.movement_params.use_final_heading() {
            let heading = if absolute_final {
                self.movement_params.desired_heading
            } else {
                let mut h = heading_to_target + self.movement_params.desired_heading;
                if h >= 360.0 {
                    h -= 360.0;
                }
                h
            };
            self.pending_nodes
                .push_back(MoveToNode::TurnToHeading(heading));
        }
    }

    /// `TurnToObject_Internal` (acclient.c:345911-345951):
    /// heading-to-target + stored desired offset, fmod 360, one
    /// type-9 node.
    fn build_turn_to_object_node(&mut self, view: &MoveToView, target: WorldPosition) {
        self.current_target_position = Some(target);
        let heading = (heading_deg_between(&view.self_pos, &target)
            + self.movement_params.desired_heading)
            .rem_euclid(360.0);
        self.pending_nodes
            .push_back(MoveToNode::TurnToHeading(heading));
    }

    /// `BeginNextNode` (acclient.c:345521-345567): head type 9 →
    /// BeginTurnToHeading; type 7 → BeginMoveForward; EMPTY → arrival
    /// (sticky bit set → `stick_to` handoff, :345553-345566; else
    /// plain CleanUp + StopCompletely + completion `Some(0)`).
    fn begin_next_node(&mut self, view: &MoveToView, out: &mut MoveToDriveOutput) {
        match self.pending_nodes.front().copied() {
            Some(MoveToNode::TurnToHeading(_)) => self.begin_turn_to_heading(view, out),
            Some(MoveToNode::MoveToPosition) => self.begin_move_forward(view, out),
            None => {
                let stick = if self.movement_params.sticky() {
                    match self.directive.as_ref() {
                        Some(MoveToDirective::MoveToObject { target, .. }) => Some((
                            *target,
                            self.sought_object_radius,
                            self.sought_object_height,
                        )),
                        _ => None,
                    }
                } else {
                    None
                };
                let params = self.cleanup_params();
                if self.current_command != 0 {
                    out.stop_motions.push((self.current_command, params));
                }
                if self.aux_command != 0 {
                    out.stop_motions.push((self.aux_command, params));
                }
                out.stop_completely = true;
                out.stick_to = stick;
                self.completion = Some(0);
                self.reset_driver_state();
                self.directive = None;
                self.pending_hit_ground_rebegin = false;
            }
        }
    }

    /// `BeginMoveForward` (acclient.c:345371-345452).
    fn begin_move_forward(&mut self, view: &MoveToView, out: &mut MoveToDriveOutput) {
        let distance = self.current_distance(view);
        let Some(target) = self.current_target_position else {
            self.cancel_into(8, out);
            return;
        };
        let delta = fold_heading_delta(
            heading_deg_between(&view.self_pos, &target) - self_heading_deg(&view.self_pos),
        );
        let (command, hold_key, moving_away) = self.movement_params.get_command(distance, delta);
        if let Some(command) = command {
            // FRESH default params, CancelMoveTo bit stripped, carrying
            // stored speed + the probed hold key (:345408-345414).
            let mut params = MovementParameters::default();
            params.bitfield &= !0x8000;
            params.speed = self.movement_params.speed;
            params.hold_key_to_apply = hold_key;
            out.do_motions.push((command, params));
            self.current_command = command;
            self.moving_away = moving_away;
            self.movement_params.hold_key_to_apply = hold_key;
            self.previous_distance = distance;
            self.previous_distance_time = Some(view.now);
            self.original_distance = distance;
            self.original_distance_time = Some(view.now);
        } else {
            self.pending_nodes.pop_front();
            self.begin_next_node(view, out);
        }
    }

    /// `BeginTurnToHeading` (acclient.c:345456-345518): bail while
    /// `motions_pending` (:345480-345481); already-there → pop +
    /// next; else shortest-arc TurnRight/TurnLeft `_DoMotion`
    /// (:345487-345498), stamping `current_command` +
    /// `previous_heading` (= the DIFF — the retail/ACE quirk, ported
    /// verbatim, :345516 / MoveToManager.cs:459).
    fn begin_turn_to_heading(&mut self, view: &MoveToView, out: &mut MoveToDriveOutput) {
        let Some(MoveToNode::TurnToHeading(node_heading)) = self.pending_nodes.front().copied()
        else {
            self.cancel_into(8, out);
            return;
        };
        if view.motions_pending {
            return;
        }
        let diff = heading_diff(
            node_heading,
            self_heading_deg(&view.self_pos),
            MOTION_TURN_RIGHT,
        );
        let motion = if diff > MOVETO_EPSILON && diff <= 180.0 {
            MOTION_TURN_RIGHT
        } else if diff > 180.0 && 360.0 - diff > MOVETO_EPSILON {
            MOTION_TURN_LEFT
        } else {
            self.pending_nodes.pop_front();
            self.begin_next_node(view, out);
            return;
        };
        let mut params = MovementParameters::default();
        params.bitfield &= !0x8000;
        params.speed = self.movement_params.speed;
        params.hold_key_to_apply = self.movement_params.hold_key_to_apply;
        out.do_motions.push((motion, params));
        self.current_command = motion;
        self.previous_heading = diff;
    }

    /// `HandleMoveToPosition` (acclient.c:345577-345709). The
    /// target-quantum tail (:345695-345707) is interpolation-rate
    /// plumbing for the retail TargetManager — N/A here (the A2 lane
    /// owns remote interpolation); documented, not ported.
    fn handle_move_to_position(&mut self, view: &MoveToView, out: &mut MoveToDriveOutput) {
        let Some(target) = self.current_target_position else {
            self.cancel_into(8, out);
            return;
        };
        let params = self.cleanup_params();
        if view.motions_pending {
            if self.aux_command != 0 {
                out.stop_motions.push((self.aux_command, params));
                self.aux_command = 0;
            }
        } else {
            // (a) aux-turn-while-walking (:345620-345651): desired =
            // heading-to-target + the 0/180 walk-direction offset.
            let mut desired = heading_deg_between(&view.self_pos, &target)
                + MovementParameters::get_desired_heading(self.current_command, self.moving_away);
            if desired >= 360.0 {
                desired -= 360.0;
            }
            let delta = fold_heading_delta(desired - self_heading_deg(&view.self_pos));
            if delta <= 20.0 || delta >= 340.0 {
                if self.aux_command != 0 {
                    out.stop_motions.push((self.aux_command, params));
                    self.aux_command = 0;
                }
            } else {
                let aux = if delta >= 180.0 {
                    MOTION_TURN_LEFT
                } else {
                    MOTION_TURN_RIGHT
                };
                if aux != self.aux_command {
                    out.do_motions.push((aux, params));
                    self.aux_command = aux;
                }
            }
        }

        // (b) progress (:345653-345661) — stall increments only when
        // neither interpolating nor motions pending; a stalled frame
        // SKIPS the arrival check (retail goto LABEL_36).
        let distance = self.current_distance(view);
        if !self.check_progress_made(distance, view.now) {
            if !view.is_interpolating && !view.motions_pending {
                self.fail_progress_count += 1;
            }
            return;
        }
        self.fail_progress_count = 0;

        // (c) arrival (:345663-345686) / fail-distance (:345689-345692).
        let arrived = if self.moving_away {
            distance >= self.movement_params.min_distance
        } else {
            distance <= self.movement_params.distance_to_object
        };
        if arrived {
            self.pending_nodes.pop_front();
            out.stop_motions.push((self.current_command, params));
            self.current_command = 0;
            if self.aux_command != 0 {
                out.stop_motions.push((self.aux_command, params));
                self.aux_command = 0;
            }
            self.begin_next_node(view, out);
        } else if let Some(start) = self.starting_position
            && start.distance_to(&view.self_pos) > self.movement_params.fail_distance
        {
            self.cancel_into(0x3D, out);
        }
    }

    /// `HandleTurnToHeading` (acclient.c:345712-345787): overshoot
    /// (`heading_greater`) → `set_heading` SNAP + pop + stop + next
    /// (:345739-345760); else stall detection (:345762-345774).
    fn handle_turn_to_heading(&mut self, view: &MoveToView, out: &mut MoveToDriveOutput) {
        let Some(MoveToNode::TurnToHeading(node_heading)) = self.pending_nodes.front().copied()
        else {
            self.cancel_into(8, out);
            return;
        };
        if self.current_command != MOTION_TURN_RIGHT && self.current_command != MOTION_TURN_LEFT {
            self.begin_turn_to_heading(view, out);
            return;
        }
        let curr_heading = self_heading_deg(&view.self_pos);
        if heading_greater(curr_heading, node_heading, self.current_command) {
            self.fail_progress_count = 0;
            out.set_heading = Some(node_heading.to_radians());
            self.pending_nodes.pop_front();
            out.stop_motions
                .push((self.current_command, self.cleanup_params()));
            self.current_command = 0;
            self.begin_next_node(view, out);
        } else {
            let diff = heading_diff(curr_heading, self.previous_heading, self.current_command);
            if diff >= 180.0 || diff <= MOVETO_EPSILON {
                self.previous_heading = curr_heading;
                if !view.is_interpolating && !view.motions_pending {
                    self.fail_progress_count += 1;
                }
            } else {
                self.fail_progress_count = 0;
                self.previous_heading = curr_heading;
            }
        }
    }

    /// The per-tick steering re-supply descriptor (shim consumer; see
    /// [`MoveToSteer`]).
    fn current_steer(&self) -> Option<MoveToSteer> {
        self.directive.as_ref()?;
        match self.pending_nodes.front()? {
            MoveToNode::MoveToPosition
                if matches!(
                    self.current_command,
                    MOTION_WALK_FORWARD | MOTION_WALK_BACKWARDS | MOTION_RUN_FORWARD
                ) =>
            {
                Some(MoveToSteer::Walk {
                    target: self.current_target_position?,
                    away: self.moving_away,
                    run: self.movement_params.hold_key_to_apply == 2,
                })
            }
            MoveToNode::TurnToHeading(heading)
                if self.current_command == MOTION_TURN_RIGHT
                    || self.current_command == MOTION_TURN_LEFT =>
            {
                Some(MoveToSteer::Turn {
                    heading_deg: *heading,
                })
            }
            _ => None,
        }
    }

    /// `MoveToManager::UseTime` (acclient.c:346018-346049) — the real
    /// per-frame driver (spec M3). Pure: no world access, no sends.
    /// Gates: walkable contact (:346024), then either the deferred
    /// entry build (the `initialized` / `HandleUpdateTarget` analog,
    /// :346030 + :345859/:345911) or the head-node Handle* dispatch.
    pub(crate) fn use_time(&mut self, view: &MoveToView) -> MoveToDriveOutput {
        let mut out = MoveToDriveOutput::default();
        if self.directive.is_none() {
            out.completion = self.completion;
            return out;
        }
        // Contact gate — off-ground: no-op (HitGround re-begins on
        // touchdown, :345570-345574).
        if !view.on_walkable_contact {
            out.completion = self.completion;
            return out;
        }

        if !self.initialized {
            // Deferred entry: stamp + build + BeginNextNode. Targeted
            // directives WAIT for a resolved pose (retail initialized=0
            // until HandleUpdateTarget, :346030).
            let directive = self.directive.clone();
            match directive {
                Some(MoveToDirective::MoveToObject { .. }) => {
                    let Some(target_pos) = view.target_pos else {
                        out.completion = self.completion;
                        return out;
                    };
                    self.starting_position = Some(view.self_pos);
                    if self.pending_entry_stop {
                        out.stop_completely = true;
                        self.pending_entry_stop = false;
                    }
                    self.build_move_nodes(view, target_pos, false);
                    self.initialized = true;
                    self.begin_next_node(view, &mut out);
                }
                Some(MoveToDirective::MoveToPosition { ref origin, .. }) => {
                    self.starting_position = Some(view.self_pos);
                    if self.pending_entry_stop {
                        out.stop_completely = true;
                        self.pending_entry_stop = false;
                    }
                    let target = origin_to_world(origin);
                    self.build_move_nodes(view, target, true);
                    self.initialized = true;
                    self.begin_next_node(view, &mut out);
                }
                Some(MoveToDirective::TurnToObject { .. }) => {
                    let Some(target_pos) = view.target_pos else {
                        out.completion = self.completion;
                        return out;
                    };
                    self.starting_position = Some(view.self_pos);
                    if self.pending_entry_stop {
                        out.stop_completely = true;
                        self.pending_entry_stop = false;
                    }
                    self.build_turn_to_object_node(view, target_pos);
                    self.initialized = true;
                    self.begin_next_node(view, &mut out);
                }
                Some(MoveToDirective::TurnToHeading { .. }) => {
                    self.starting_position = Some(view.self_pos);
                    if self.pending_entry_stop {
                        out.stop_completely = true;
                        self.pending_entry_stop = false;
                    }
                    let heading = self.movement_params.desired_heading;
                    self.pending_nodes
                        .push_back(MoveToNode::TurnToHeading(heading));
                    self.initialized = true;
                    self.begin_next_node(view, &mut out);
                }
                None => {}
            }
        } else {
            // Per-tick target refresh — the HandleUpdateTarget cadence
            // (type 6 stamp reset change-gated, :346088-346101).
            if matches!(self.directive, Some(MoveToDirective::MoveToObject { .. }))
                && let Some(target_pos) = view.target_pos
            {
                self.refresh_moveto_target(target_pos, view.now);
            }
            if self.pending_hit_ground_rebegin {
                // HitGround re-begin (:345570-345574).
                self.pending_hit_ground_rebegin = false;
                self.begin_next_node(view, &mut out);
            } else {
                match self.pending_nodes.front().copied() {
                    Some(MoveToNode::MoveToPosition) => {
                        self.handle_move_to_position(view, &mut out)
                    }
                    Some(MoveToNode::TurnToHeading(_)) => {
                        self.handle_turn_to_heading(view, &mut out)
                    }
                    None => {
                        // Defensive — an initialized directive with an
                        // empty queue resolves through the arrival arm.
                        self.begin_next_node(view, &mut out);
                    }
                }
            }
        }

        out.completion = self.completion;
        out.steer = self.current_steer();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::{Quaternion, Vector3};
    use std::time::Duration;

    const LB: u32 = 0xA9B4_0001;

    fn origin(x: f32, y: f32) -> Origin {
        Origin {
            cell_id: Guid::from(LB),
            position: holtburger_common::math::Vector3::new(x, y, 0.0),
        }
    }

    fn pose(x: f32, y: f32, heading_deg: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(LB),
            coords: Vector3::new(x, y, 0.0),
            rotation: Quaternion::from_heading(heading_deg.to_radians()),
        }
    }

    fn view(self_pos: WorldPosition, target: Option<WorldPosition>, now: Instant) -> MoveToView {
        MoveToView {
            on_walkable_contact: true,
            self_pos,
            self_radius: 0.4,
            self_height: 1.8,
            target_pos: target,
            motions_pending: false,
            is_interpolating: false,
            now,
        }
    }

    /// `cylinder_distance` port (acclient.c:467221-467266): UseSpheres
    /// metric vs point distance; degenerate dims = point-equivalent.
    #[test]
    fn current_distance_cylinder_vs_point() {
        // Lateral separation, vertical overlap: reach = 10 − (0.4+0.5).
        let a = pose(0.0, 0.0, 0.0);
        let b = pose(10.0, 0.0, 0.0);
        let d = cylinder_distance(0.4, 1.8, &a, 0.5, 1.8, &b);
        assert!((d - 9.1).abs() < 1e-4, "{d}");

        // Degenerate dims = point distance.
        let d0 = cylinder_distance(0.0, 0.0, &a, 0.0, 0.0, &b);
        assert!((d0 - 10.0).abs() < 1e-4);

        // Vertical gap (z-stacked cylinders): reach = 5 − 0.8 = 4.2,
        // dz = 5 − 1.8 = 3.2, both positive → sqrt(dz² + reach²)
        // (the 3D-offset reach is the decomp's, :467238).
        let mut high = b;
        high.coords = Vector3::new(0.0, 0.0, 5.0);
        let dz = cylinder_distance(0.4, 1.8, &a, 0.4, 1.8, &high);
        assert!(
            (dz - (3.2f32 * 3.2 + 4.2 * 4.2).sqrt()).abs() < 1e-3,
            "{dz}"
        );

        // Full overlap goes negative.
        let dn = cylinder_distance(0.4, 1.8, &a, 0.4, 1.8, &a);
        assert!(dn < 0.0);

        // Manager metric selection: default 0x1EE0F has UseSpheres.
        let mut manager = MoveToManager::default();
        manager.move_to_object(
            Guid(0x8000_0001),
            origin(10.0, 0.0),
            0.5,
            1.8,
            MovementParameters::default(),
        );
        let now = Instant::now();
        let v = view(a, Some(b), now);
        let _ = manager.use_time(&v); // resolves target + builds
        assert!((manager.current_distance(&v) - 9.1).abs() < 1e-4);

        // UseSpheres cleared → point.
        let mut params = MovementParameters::default();
        params.bitfield &= !0x400;
        manager.move_to_object(Guid(0x8000_0001), origin(10.0, 0.0), 0.5, 1.8, params);
        let _ = manager.use_time(&v);
        assert!((manager.current_distance(&v) - 10.0).abs() < 1e-4);
    }

    /// `CheckProgressMade` (acclient.c:344833-344854): <1s window
    /// always true; stalled >1s false; both-stamp semantics.
    #[test]
    fn check_progress_made_windows() {
        let mut manager = MoveToManager::default();
        let t0 = Instant::now();
        manager.moving_away = false;
        manager.previous_distance = 10.0;
        manager.previous_distance_time = Some(t0);
        manager.original_distance = 10.0;
        manager.original_distance_time = Some(t0);

        // Inside the window → true regardless of distance.
        assert!(manager.check_progress_made(10.0, t0 + Duration::from_millis(500)));

        // Past the window, no movement → false; stamps NOT refreshed.
        assert!(!manager.check_progress_made(10.0, t0 + Duration::from_millis(1500)));
        assert!((manager.previous_distance - 10.0).abs() < 1e-6);

        // Past the window, good rate on both stamps → true + refresh.
        assert!(manager.check_progress_made(8.0, t0 + Duration::from_millis(1500)));
        assert!((manager.previous_distance - 8.0).abs() < 1e-6);

        // Good previous-window rate but stalled vs ORIGINAL stamp →
        // false (the second `||` arm).
        let mut stalled = MoveToManager::default();
        stalled.previous_distance = 10.0;
        stalled.previous_distance_time = Some(t0 + Duration::from_secs(8));
        stalled.original_distance = 10.2;
        stalled.original_distance_time = Some(t0);
        assert!(!stalled.check_progress_made(8.0, t0 + Duration::from_secs(10)));
    }

    /// Entry node-build fixtures: near (no command → no nodes →
    /// immediate arrival) and far (heading + position nodes);
    /// UseFinalHeading trailing node; sticky clear on
    /// move_to_position/turn_to_heading; deferred build for targeted
    /// directives; directive replace latches 0x36 via the preamble
    /// cancel.
    #[test]
    fn entry_node_builds_and_arrival() {
        let now = Instant::now();
        // Near position → no nodes → immediate arrival Some(0).
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(0.2, 0.0), MovementParameters::default());
        assert!(manager.is_active());
        let out = manager.use_time(&view(pose(0.0, 0.0, 270.0), None, now));
        assert!(out.stop_completely);
        assert_eq!(out.completion, Some(0));
        assert!(!manager.is_active());
        assert_eq!(manager.take_completion(), Some(0));
        assert_eq!(manager.take_completion(), None, "read-clear");

        // Far position east (AC heading 180) facing north (90) →
        // heading node + position node; first frame begins the TURN.
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(50.0, 0.0), MovementParameters::default());
        let out = manager.use_time(&view(pose(0.0, 0.0, 90.0), None, now));
        assert_eq!(manager.pending_nodes.len(), 2);
        assert!(matches!(
            manager.pending_nodes.front(),
            Some(MoveToNode::TurnToHeading(h)) if (h - 180.0).abs() < 0.1
        ));
        assert_eq!(out.do_motions.len(), 1);
        assert_eq!(out.do_motions[0].0, MOTION_TURN_RIGHT);
        assert_eq!(manager.current_command, MOTION_TURN_RIGHT);

        // Sticky bit is CLEARED by move_to_position (:345852) and
        // turn_to_heading (:345990).
        let mut sticky_params = MovementParameters::default();
        sticky_params.bitfield |= 0x80;
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(50.0, 0.0), sticky_params);
        assert!(!manager.movement_params.sticky());
        manager.turn_to_heading(sticky_params);
        assert!(!manager.movement_params.sticky());

        // UseFinalHeading 0x40 → trailing heading node (absolute for
        // the position form, :345835-345836).
        let mut params = MovementParameters::default();
        params.bitfield |= 0x40;
        params.desired_heading = 45.0;
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(50.0, 0.0), params);
        let _ = manager.use_time(&view(pose(0.0, 0.0, 90.0), None, now));
        assert_eq!(manager.pending_nodes.len(), 3);
        assert!(matches!(
            manager.pending_nodes.back(),
            Some(MoveToNode::TurnToHeading(h)) if (h - 45.0).abs() < 1e-4
        ));

        // MoveToObject defers until a target pose resolves.
        let mut manager = MoveToManager::default();
        manager.move_to_object(
            Guid(0x8000_0001),
            origin(50.0, 0.0),
            0.5,
            1.8,
            MovementParameters::default(),
        );
        let out = manager.use_time(&view(pose(0.0, 0.0, 90.0), None, now));
        assert!(out.do_motions.is_empty(), "unresolved target → wait");
        assert!(!manager.initialized);
        let out = manager.use_time(&view(pose(0.0, 0.0, 90.0), Some(pose(50.0, 0.0, 0.0)), now));
        assert!(manager.initialized);
        assert_eq!(out.do_motions.len(), 1);

        // Directive replace: the facade preamble cancel latches 0x36.
        let out = manager.cancel_moveto(0x36);
        assert!(out.stop_completely);
        assert_eq!(out.completion, Some(0x36));
        manager.turn_to_heading(MovementParameters::default());
        assert!(manager.is_active());
        assert_eq!(manager.take_completion(), Some(0x36));
    }

    /// Driver state walk: turn node → shortest-arc command →
    /// overshoot → `set_heading` snap + pop (:345739-345760); then the
    /// move node walks, stamps progress, and arrives inside
    /// `distance_to_object` (:345663-345686).
    #[test]
    fn turn_then_walk_then_arrive() {
        let now = Instant::now();
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(50.0, 0.0), MovementParameters::default());

        // Frame 1 (build): facing north (90), target east (180) →
        // TurnRight begun.
        let out = manager.use_time(&view(pose(0.0, 0.0, 90.0), None, now));
        assert_eq!(out.do_motions[0].0, MOTION_TURN_RIGHT);
        assert!(
            matches!(out.steer, Some(MoveToSteer::Turn { heading_deg }) if (heading_deg - 180.0).abs() < 0.1)
        );

        // Frame 2: still short of the node heading → stall bookkeeping
        // only (no pop).
        let out = manager.use_time(&view(pose(0.0, 0.0, 150.0), None, now));
        assert!(out.set_heading.is_none());
        assert_eq!(manager.pending_nodes.len(), 2);

        // Frame 3: overshot (185 > 180 turning right) → snap + pop +
        // stop turn + begin walk.
        let out = manager.use_time(&view(pose(0.0, 0.0, 185.0), None, now));
        let snap = out.set_heading.expect("arrival snap");
        assert!((snap - 180.0f32.to_radians()).abs() < 1e-3);
        assert_eq!(out.stop_motions.len(), 1);
        assert_eq!(out.stop_motions[0].0, MOTION_TURN_RIGHT);
        assert_eq!(out.do_motions.len(), 1);
        assert_eq!(out.do_motions[0].0, MOTION_WALK_FORWARD);
        assert!(
            matches!(
                out.steer,
                Some(MoveToSteer::Walk {
                    away: false,
                    run: true,
                    ..
                })
            ),
            "50m out, threshold 15 → run hold key; steer {:?}",
            out.steer
        );

        // Frame 4: walking, far → progress window keeps it alive.
        let out = manager.use_time(&view(pose(20.0, 0.0, 180.0), None, now));
        assert!(out.completion.is_none());
        assert!(matches!(out.steer, Some(MoveToSteer::Walk { .. })));

        // Frame 5: inside distance_to_object (cylinder metric:
        // 50−49.9=0.1 − radii 0.4 → negative) → arrival: stop walk,
        // pop, empty queue → Some(0) + stop_completely.
        let out = manager.use_time(&view(pose(49.9, 0.0, 180.0), None, now));
        assert!(
            out.stop_motions
                .iter()
                .any(|(m, _)| *m == MOTION_WALK_FORWARD)
        );
        assert!(out.stop_completely);
        assert_eq!(out.completion, Some(0));
        assert!(!manager.is_active());
        assert_eq!(manager.take_completion(), Some(0));
    }

    /// moving_away arrival at `min_distance`; aux-turn engages > 20°
    /// off-bearing and stops ≤ 20° (:345620-345651); fail-distance →
    /// Some(0x3D) (:345689-345692); stall increments
    /// fail_progress_count only when !interpolating &&
    /// !motions_pending (:345657-345659).
    #[test]
    fn away_aux_fail_distance_and_stall() {
        let now = Instant::now();

        // Away-only params: min_distance 10, start at 2 → WalkForward
        // moving_away; arrival at dist >= min_distance.
        let mut params = MovementParameters::default();
        params.bitfield &= !0x200;
        params.bitfield |= 0x100;
        params.bitfield &= !0x400; // point metric for easy numbers
        params.min_distance = 10.0;
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(0.0, 0.0), params);
        // Build frame: standing 2m east of target facing west (0):
        // heading-to-target = 0 → no initial turn? heading to target is
        // 0 (west); facing 0 → delta 0 → turn node pops instantly and
        // the walk begins on the same frame.
        let out = manager.use_time(&view(pose(2.0, 0.0, 0.0), None, now));
        assert_eq!(out.do_motions.len(), 1);
        assert_eq!(out.do_motions[0].0, MOTION_WALK_FORWARD);
        assert!(manager.moving_away);
        assert!(matches!(
            out.steer,
            Some(MoveToSteer::Walk { away: true, .. })
        ));

        // Aux turn: walking away the desired facing is heading-to-target
        // + 180. At 2m east facing west (0°), desired = 180 → delta 180
        // → aux turn engages (>20, <340).
        let out = manager.use_time(&view(pose(2.0, 0.0, 0.0), None, now));
        assert!(
            out.do_motions.iter().any(|(m, _)| *m == MOTION_TURN_LEFT),
            "180 delta → TurnLeft aux: {:?}",
            out.do_motions
        );
        assert_eq!(manager.aux_command, MOTION_TURN_LEFT);

        // Once facing within 20° of desired (facing east, 180), the aux
        // stops.
        let out = manager.use_time(&view(pose(5.0, 0.0, 180.0), None, now));
        assert!(out.stop_motions.iter().any(|(m, _)| *m == MOTION_TURN_LEFT));
        assert_eq!(manager.aux_command, 0);

        // Arrival away: dist >= min_distance.
        let out = manager.use_time(&view(pose(11.0, 0.0, 180.0), None, now));
        assert_eq!(out.completion, Some(0));

        // Fail-distance: tiny fail_distance → cancel 0x3D once moved.
        let mut params = MovementParameters::default();
        params.bitfield &= !0x400;
        params.fail_distance = 5.0;
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(50.0, 0.0), params);
        let _ = manager.use_time(&view(pose(0.0, 0.0, 180.0), None, now)); // build (stamps start)
        let out = manager.use_time(&view(pose(8.0, 0.0, 180.0), None, now));
        assert_eq!(out.completion, Some(0x3D));
        assert_eq!(manager.take_completion(), Some(0x3D));
        assert!(!manager.is_active());

        // Stall: same spot past the 1s window → fail_progress_count++
        // only when not interpolating / no motions pending.
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(50.0, 0.0), MovementParameters::default());
        let _ = manager.use_time(&view(pose(0.0, 0.0, 180.0), None, now));
        let later = now + Duration::from_millis(1500);
        let mut stalled_view = view(pose(0.0, 0.0, 180.0), None, later);
        stalled_view.motions_pending = true;
        let _ = manager.use_time(&stalled_view);
        assert_eq!(
            manager.fail_progress_count, 0,
            "motions pending → no increment"
        );
        stalled_view.motions_pending = false;
        stalled_view.is_interpolating = true;
        let _ = manager.use_time(&stalled_view);
        assert_eq!(
            manager.fail_progress_count, 0,
            "interpolating → no increment"
        );
        stalled_view.is_interpolating = false;
        let _ = manager.use_time(&stalled_view);
        assert_eq!(manager.fail_progress_count, 1);
    }

    /// Sticky-bit arrival → `stick_to(target, r, h)`
    /// (:345544-345566): only MoveToObject keeps the bit
    /// (position/heading entries strip it).
    #[test]
    fn sticky_arrival_emits_stick_to() {
        let now = Instant::now();
        let mut params = MovementParameters::default();
        params.bitfield |= 0x80;
        let mut manager = MoveToManager::default();
        let target_guid = Guid(0x8000_0042);
        manager.move_to_object(target_guid, origin(1.0, 0.0), 0.5, 1.2, params);
        // Already inside cylinder arrival distance → build finds no
        // command → immediate arrival with the sticky handoff.
        let out = manager.use_time(&view(pose(0.0, 0.0, 0.0), Some(pose(1.0, 0.0, 0.0)), now));
        assert_eq!(out.completion, Some(0));
        assert_eq!(out.stick_to, Some((target_guid, 0.5, 1.2)));
        assert!(out.stop_completely);
    }

    /// Contract lifecycle: `is_active` false→true→false;
    /// `take_completion` read-clear + persistence across ticks;
    /// cancel during turn vs walk emits the CleanUp stop set with the
    /// CancelMoveTo bit stripped (:345148-345164).
    #[test]
    fn contract_lifecycle_and_cancel_cleanup() {
        let now = Instant::now();
        let mut manager = MoveToManager::default();
        assert!(!manager.is_active());
        assert_eq!(manager.take_completion(), None);

        // Cancel during turn.
        manager.move_to_position(origin(50.0, 0.0), MovementParameters::default());
        assert!(manager.is_active());
        let _ = manager.use_time(&view(pose(0.0, 0.0, 90.0), None, now));
        assert_eq!(manager.current_command, MOTION_TURN_RIGHT);
        let out = manager.cancel_moveto(0x36);
        assert_eq!(out.stop_motions.len(), 1);
        assert_eq!(out.stop_motions[0].0, MOTION_TURN_RIGHT);
        assert!(!out.stop_motions[0].1.cancel_moveto(), "bit 15 stripped");
        assert!(out.stop_completely);
        assert!(!manager.is_active());

        // Latch persists until read (across "ticks").
        let idle = manager.use_time(&view(pose(0.0, 0.0, 90.0), None, now));
        assert_eq!(idle.completion, Some(0x36), "mirror until read");
        assert_eq!(manager.take_completion(), Some(0x36));
        assert_eq!(manager.take_completion(), None);

        // Cancel during walk (incl. aux) stops both.
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(50.0, 0.0), MovementParameters::default());
        let _ = manager.use_time(&view(pose(0.0, 0.0, 180.0), None, now)); // build+begin: aligned → walk begins
        assert_eq!(manager.current_command, MOTION_WALK_FORWARD);
        manager.aux_command = MOTION_TURN_RIGHT; // synthetic aux
        let out = manager.cancel_moveto(0x36);
        assert_eq!(out.stop_motions.len(), 2);

        // Cancel with nothing active is a retail no-op (:345303).
        let mut manager = MoveToManager::default();
        let out = manager.cancel_moveto(0x36);
        assert_eq!(out, MoveToDriveOutput::default());
        assert_eq!(manager.take_completion(), None);
    }

    /// `hit_ground` re-begin consumes the marker (:345570-345574);
    /// off-ground `use_time` is a no-op (contact gate :346024).
    #[test]
    fn hit_ground_rebegin_and_contact_gate() {
        let now = Instant::now();
        let mut manager = MoveToManager::default();
        manager.hit_ground();
        assert!(
            !manager.pending_hit_ground_rebegin(),
            "no directive, no re-begin owed"
        );

        manager.move_to_position(origin(50.0, 0.0), MovementParameters::default());
        let _ = manager.use_time(&view(pose(0.0, 0.0, 180.0), None, now)); // build; aligned → walk
        assert_eq!(manager.current_command, MOTION_WALK_FORWARD);

        // Airborne: gate no-ops (state untouched).
        let before = manager.clone();
        let mut airborne = view(pose(5.0, 0.0, 180.0), None, now);
        airborne.on_walkable_contact = false;
        let out = manager.use_time(&airborne);
        assert!(out.do_motions.is_empty() && out.stop_motions.is_empty());
        assert_eq!(manager, before, "off-ground use_time is inert");

        // Touchdown: re-begin re-issues the walk command.
        manager.hit_ground();
        assert!(manager.pending_hit_ground_rebegin());
        let out = manager.use_time(&view(pose(5.0, 0.0, 180.0), None, now));
        assert!(!manager.pending_hit_ground_rebegin());
        assert_eq!(
            out.do_motions.len(),
            1,
            "re-begin re-issues the head command"
        );

        // cancel clears the owed re-begin.
        manager.hit_ground();
        let _ = manager.cancel_moveto(0x36);
        assert!(!manager.pending_hit_ground_rebegin());
    }

    /// TurnToHeading entry → single node + run through the snap; the
    /// hold-key force-run rides `get_command`'s 0x10 path on walk
    /// directives (`run` in the steer).
    #[test]
    fn turn_to_heading_directive_runs_to_snap() {
        let now = Instant::now();
        let mut params = MovementParameters::default();
        params.desired_heading = 90.0;
        let mut manager = MoveToManager::default();
        manager.turn_to_heading(params);

        let out = manager.use_time(&view(pose(0.0, 0.0, 0.0), None, now));
        assert_eq!(out.do_motions.len(), 1);
        assert_eq!(out.do_motions[0].0, MOTION_TURN_RIGHT);

        let out = manager.use_time(&view(pose(0.0, 0.0, 91.0), None, now));
        assert!((out.set_heading.expect("snap") - 90.0f32.to_radians()).abs() < 1e-3);
        assert_eq!(out.completion, Some(0));
        assert!(!manager.is_active());

        // Force-run bit: a far walk under 0x10 carries Run.
        let mut run_params = MovementParameters::default();
        run_params.bitfield |= 0x10;
        let mut manager = MoveToManager::default();
        manager.move_to_position(origin(5.0, 0.0), run_params);
        let out = manager.use_time(&view(pose(0.0, 0.0, 180.0), None, now));
        assert_eq!(out.do_motions.len(), 1);
        assert_eq!(out.do_motions[0].1.hold_key_to_apply, 2);
        // run promotion happens in the lattice (adjust_motion), not
        // here — the raw command stays WalkForward.
        assert_ne!(out.do_motions[0].0, MOTION_RUN_FORWARD);
    }

    /// `handle_update_target` stays the A2-P3 record anchor.
    #[test]
    fn handle_update_target_records_anchor() {
        let mut manager = MoveToManager::default();
        let target = Guid(0x8000_0002);
        manager.handle_update_target(target, origin(1.0, 2.0));
        assert_eq!(manager.last_target_update().map(|(g, _)| *g), Some(target));
    }
}

#[cfg(test)]
mod quantum_turn_tests {
    use super::*;
    use holtburger_common::{Guid, Quaternion, Vector3};
    use std::time::Duration;

    /// A1-O5 discharge (2026-07-03) — ACE kept MAX_QUANTUM at 0.1
    /// because ITS MoveToManager port "was buggy with turning" at
    /// retail's 0.2 slices. This closed-loop regression drives OUR
    /// port's TurnToHeading at BOTH quanta with the retail turn omega
    /// (~1.5 rad/s ≈ 17°/slice at 0.2 s — every slice overshoots the
    /// 0.0002 epsilon, the exact coarse regime the ruling feared) and
    /// asserts: convergence with the overshoot SNAP
    /// (acclient.c:345746), zero direction flapping, success
    /// completion. Green here = the ruling's stated concern does not
    /// reproduce in this port.
    #[test]
    fn turn_to_heading_converges_without_oscillation_at_retail_quantum() {
        const LB: u32 = 0xA9B4_0001;
        let pose = |heading_deg: f32| WorldPosition {
            landblock_id: Guid(LB),
            coords: Vector3::new(50.0, 50.0, 0.0),
            rotation: Quaternion::from_heading(heading_deg.to_radians()),
        };
        for &quantum in &[0.1_f32, 0.2] {
            let omega_deg_per_sec = 1.5_f32.to_degrees();
            let mut manager = MoveToManager::default();
            let mut params = MovementParameters::default();
            params.desired_heading = 90.0;
            manager.turn_to_heading(params);

            let mut heading = 0.0_f32;
            let mut now = Instant::now();
            let mut active_turn: Option<u32> = None;
            let mut direction_flips = 0;
            let mut completion: Option<u32> = None;
            for _ in 0..100 {
                now += Duration::from_secs_f32(quantum);
                let v = MoveToView {
                    on_walkable_contact: true,
                    self_pos: pose(heading),
                    self_radius: 0.4,
                    self_height: 1.8,
                    target_pos: None,
                    motions_pending: false,
                    is_interpolating: false,
                    now,
                };
                let out = manager.use_time(&v);
                for &(motion, _) in &out.do_motions {
                    if motion == MOTION_TURN_RIGHT || motion == MOTION_TURN_LEFT {
                        if let Some(prev) = active_turn
                            && prev != motion
                        {
                            direction_flips += 1;
                        }
                        active_turn = Some(motion);
                    }
                }
                for &(motion, _) in &out.stop_motions {
                    if Some(motion) == active_turn {
                        active_turn = None;
                    }
                }
                // Integrate the commanded turn across this slice
                // (right = heading increases, cli omega convention).
                match active_turn {
                    Some(MOTION_TURN_RIGHT) => {
                        heading = (heading + omega_deg_per_sec * quantum).rem_euclid(360.0)
                    }
                    Some(MOTION_TURN_LEFT) => {
                        heading = (heading - omega_deg_per_sec * quantum).rem_euclid(360.0)
                    }
                    _ => {}
                }
                if let Some(snap) = out.set_heading {
                    heading = snap.to_degrees().rem_euclid(360.0);
                }
                completion = completion.or(out.completion).or(manager.take_completion());
                if completion.is_some() {
                    break;
                }
            }
            assert_eq!(
                completion,
                Some(0),
                "quantum {quantum}: turn directive completes successfully"
            );
            assert_eq!(
                direction_flips, 0,
                "quantum {quantum}: no left/right oscillation (the ACE 0.2 bug)"
            );
            assert!(
                (heading - 90.0).abs() < 0.5,
                "quantum {quantum}: snapped onto the target heading, got {heading}"
            );
        }
    }
}
