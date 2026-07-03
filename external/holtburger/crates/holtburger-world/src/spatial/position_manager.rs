//! A2-P1 (2026-06-12, unification survey A2 position-manager-trio §4
//! Stage P1) — the retail `PositionManager` shape: ONE manager per
//! spatial body holding the interpolation + constraint sub-managers
//! (`acclient.h:30952-30956`; sticky is the P3/W5 slice), with the
//! interpolation side generalized from the single-target
//! [`RetailForcePositionInterpolator`] into retail's NODE QUEUE:
//! ≤20 nodes (`acclient.c:389071` `< 0x14`), tail dedupe within 0.05 m
//! (`:389052-389063`), Position(1)/Snap(2)/Velocity(3) node types
//! (`InterpolationNode`, 0x60 bytes: type +4, objcell_id +12, frame +16,
//! velocity +80), `UseTime` drain (`:389278-389380`) and
//! `node_fail_counter > 3` → `SetPositionSimple` blipto recovery
//! (`:389300-389360`), `NodeCompleted` re-seed/save (`:388882-388946`).
//! ACE 1:1: `Physics/Managers/InterpolationManager.cs` /
//! `ConstraintManager.cs` / `PositionManager.cs`.
//!
//! Gate: [`USE_POSITION_MANAGER_QUEUE`] default-off — the facade
//! delegates to the embedded legacy single-node interpolator
//! byte-identically (survey A2 §4 P1 rollback contract). The queue path
//! is exercised by unit tests until the flag flips. Remote-entity
//! wiring (`InterpolateTo` from `MoveOrTeleport`, the 96 m snap branch)
//! is Stage P2; sticky is P3.

use crate::spatial::force_position_interp::{
    InterpStep, MAX_INTERPOLATED_VELOCITY, RECONCILE_DEADBAND_M, RetailForcePositionInterpolator,
};
use holtburger_common::guid::Guid;
use holtburger_common::math::{Quaternion, Vector3};
use holtburger_common::position::{METERS_PER_LANDBLOCK, WorldPosition};
use std::collections::VecDeque;

/// A2-P1 queue gate (survey A2 §4 Stage P1) — Default ON (a7cfb75e, "enable
/// full unified pipeline"). OFF: the
/// [`PositionManager`] facade delegates every call to the legacy
/// single-node [`RetailForcePositionInterpolator`], byte-identical to
/// the pre-P1 behavior. ON: force-position installs route through the
/// retail node QUEUE (`interpolate_to` dedupe/cap, `use_time` drain,
/// fail→blipto recovery). Rust const (url-flags.md §6 pattern):
/// flipping means editing this source + wasm rebuild.
pub const USE_POSITION_MANAGER_QUEUE: bool = true;

/// A2-P3 sticky gate (survey A2 §4 Stage P3, W3+ S9; RULINGS item 4) —
/// Default ON (a7cfb75e, "enable full unified pipeline"). OFF: no caller
/// installs a sticky target, so the
/// [`StickyManager`] slice is inert and every consumer site
/// (`movement/system.rs` step/unstick, `client/simulation.rs` install,
/// wasm `lib.rs` install/feed) early-outs — byte-identical to pre-P3.
/// ON: server `StickToObject` motions (incl. the LOCAL player's own
/// melee-swing echo, ACE `Player_Melee.cs:420-427` +
/// `Network/Motion/MovementInvalid.cs:45-46` — live-server cites) glue
/// the addressed object to its target via the retail
/// `StickyManager::adjust_offset` pull (acclient.c:388519-388601).
/// Rust const (url-flags.md §6 pattern): flipping means editing this
/// source + wasm rebuild.
pub const USE_STICKY_MANAGER: bool = true;

/// `StickyManager` standoff shrink — retail subtracts 0.3 from the
/// radii-aware cylinder distance (acclient.c:388559-388560; ACE
/// `StickyManager.cs` `StickyRadius = 0.3f`).
pub const STICKY_RADIUS: f32 = 0.3;

/// Sticky timeout — `StickTo` arms `cur_time + 1.0`
/// (acclient.c:388688; ACE `StickyManager.cs` `StickyTime = 1.0f`).
pub const STICKY_TIME: f32 = 1.0;

/// `BIG_DISTANCE` (`acclient.c:41537`) — `original_distance` idle seed.
pub const BIG_DISTANCE: f32 = 999_999.0;

/// Queue cap — `InterpolateTo` pops HEAD nodes while the queue holds
/// `>= 0x14` (`acclient.c:389071`).
pub const INTERPOLATION_QUEUE_CAP: usize = 20;

/// `F_EPSILON` (`acclient.c:39545` `0.00019999999`; ACE
/// `PhysicsGlobals.EPSILON = 0.0002f` — same f32 bits).
const EPSILON: f32 = 0.0002;

/// `InterpolationManager` 5-frame progress window
/// (`acclient.c:389243`; ACE `InterpolationManager.cs:230`).
const PROGRESS_WINDOW_FRAMES: i32 = 5;

/// Minimum closing fraction of `max_speed` over the window
/// (`acclient.c:389243-389245`; ACE `:231`).
const MIN_PROGRESS_RATIO: f32 = 0.3;

/// Retail `InterpolationNode` types (`acclient.c` `UseTime` dispatch
/// `:389368-389378`, recovery `:389310-389318`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterpolationNodeType {
    /// Type 1 — eased toward by the per-frame `adjust_offset`.
    Position,
    /// Type 2 — drained by `UseTime` via `NodeCompleted(1)` with no side
    /// effect; carries a velocity the fail-recovery path may read.
    Snap,
    /// Type 3 — `UseTime` applies `set_velocity` then `NodeCompleted(1)`.
    Velocity,
}

/// One queued node (retail 0x60-byte `InterpolationNode`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InterpolationNode {
    pub node_type: InterpolationNodeType,
    pub position: WorldPosition,
    pub velocity: Vector3,
}

impl InterpolationNode {
    pub fn position_node(position: WorldPosition) -> Self {
        Self {
            node_type: InterpolationNodeType::Position,
            position,
            velocity: Vector3::zero(),
        }
    }

    pub fn velocity_node(position: WorldPosition, velocity: Vector3) -> Self {
        Self {
            node_type: InterpolationNodeType::Velocity,
            position,
            velocity,
        }
    }
}

/// Physics side effects the headless `use_time` drain emits — retail
/// calls `CPhysicsObj::SetPositionSimple` / `set_velocity` directly
/// (`acclient.c:389320-389368`); the scene owner applies these to the
/// body (A4-Q1 `MotionTableEvent` pattern). DEVIATION (documented):
/// retail retries the blip next frame when `SetPositionSimple` errors;
/// our scene's pose assignment cannot fail, so the
/// retry-on-error branch is not modeled.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InterpolationCommand {
    /// `SetPositionSimple(pos, true)` — hard blip.
    SetPosition(WorldPosition),
    /// `set_velocity(v, true)`.
    SetVelocity(Vector3),
}

/// The queue-generalized `InterpolationManager`
/// (`acclient.h` fields: position_queue, original_distance,
/// progress_quantum, frame_counter, node_fail_counter, keep_heading,
/// blipto_position).
#[derive(Debug, Clone, PartialEq)]
pub struct InterpolationManager {
    position_queue: VecDeque<InterpolationNode>,
    keep_heading: bool,
    node_fail_counter: u32,
    original_distance: f32,
    frame_counter: i32,
    progress_quantum: f32,
    /// Saved recovery pose — `NodeCompleted(success=0)` stashes the
    /// failed node's position (`acclient.c:388923-388937`).
    blipto_position: Option<WorldPosition>,
}

impl Default for InterpolationManager {
    fn default() -> Self {
        Self {
            position_queue: VecDeque::new(),
            keep_heading: false,
            node_fail_counter: 0,
            original_distance: BIG_DISTANCE,
            frame_counter: 0,
            progress_quantum: 0.0,
            blipto_position: None,
        }
    }
}

impl InterpolationManager {
    pub fn is_interpolating(&self) -> bool {
        !self.position_queue.is_empty()
    }

    pub fn node_count(&self) -> usize {
        self.position_queue.len()
    }

    pub fn node_fail_counter(&self) -> u32 {
        self.node_fail_counter
    }

    pub fn front(&self) -> Option<&InterpolationNode> {
        self.position_queue.front()
    }

    /// `InterpolationManager::StopInterpolating` — clear the queue and
    /// reset the progress fields (ACE `InterpolationManager.cs:133-140`).
    pub fn stop_interpolating(&mut self) {
        self.position_queue.clear();
        self.node_fail_counter = 0;
        self.frame_counter = 0;
        self.progress_quantum = 0.0;
        self.original_distance = BIG_DISTANCE;
    }

    /// `InterpolationManager::InterpolateTo(p, keep_heading)`
    /// (`acclient.c:389017-389130`). `current` is the body's pose
    /// (`m_position`), `blip_distance` the caller's
    /// `GetAutonomyBlipDistance` (physics-obj-side in retail).
    ///
    /// Within the blip radius (measured from the tail position node if
    /// any, else the current pose): a ≤0.05 m gap stops interpolating
    /// (returns `false`; the CALLER snaps heading unless keep_heading —
    /// retail calls `set_heading` there, `:389131-389136`); otherwise
    /// dedupe tail position-nodes within 0.05 m of the new target, pop
    /// HEAD nodes down to the 20 cap, and append a position node.
    /// Beyond the blip radius: append the node and set
    /// `node_fail_counter = 4` so the next `use_time` hard-recovers via
    /// `SetPositionSimple` (the blip-type install, `:389140-389172`).
    ///
    /// Returns `true` when a node was queued.
    pub fn interpolate_to(
        &mut self,
        current: WorldPosition,
        target: WorldPosition,
        keep_heading: bool,
        blip_distance: f32,
    ) -> bool {
        // Reference for the blip gate: tail position node, else current
        // (`acclient.c:389048-389052` tail type==1 check).
        let reference = match self.position_queue.back() {
            Some(node) if node.node_type == InterpolationNodeType::Position => node.position,
            _ => current,
        };
        let gap = reference.distance_to(&target);

        if blip_distance >= gap {
            if current.distance_to(&target) > RECONCILE_DEADBAND_M {
                // Tail dedupe (`:389052-389063`).
                while let Some(tail) = self.position_queue.back() {
                    if tail.node_type == InterpolationNodeType::Position
                        && tail.position.distance_to(&target) < RECONCILE_DEADBAND_M
                    {
                        self.position_queue.pop_back();
                    } else {
                        break;
                    }
                }
                // 20-node cap pops the HEAD (`:389066-389082`).
                while self.position_queue.len() >= INTERPOLATION_QUEUE_CAP {
                    self.position_queue.pop_front();
                }
                self.keep_heading = keep_heading;
                let node_pose = if keep_heading {
                    // Retail overwrites the node frame's heading with the
                    // body's current heading (`:389113-389117`).
                    WorldPosition {
                        rotation: current.rotation,
                        ..target
                    }
                } else {
                    target
                };
                // `original_distance` stays `BIG_DISTANCE` on a fresh
                // queue (`:388878`) — the first 5-frame progress window
                // auto-passes; `NodeCompleted` re-seeds per node.
                self.position_queue
                    .push_back(InterpolationNode::position_node(node_pose));
                true
            } else {
                // ≤ deadband: stop; heading snap is the caller's
                // (`:389131-389137`).
                self.stop_interpolating();
                false
            }
        } else {
            // Beyond blip: queue + force recovery (`:389140-389172` —
            // note retail does NOT update keep_heading on this arm).
            let node_pose = if self.keep_heading {
                WorldPosition {
                    rotation: current.rotation,
                    ..target
                }
            } else {
                target
            };
            self.position_queue
                .push_back(InterpolationNode::position_node(node_pose));
            self.node_fail_counter = 4;
            true
        }
    }

    /// Queue a velocity node — the `UseTime` drain applies it via
    /// [`InterpolationCommand::SetVelocity`] (`acclient.c:389365-389368`;
    /// wire entry is Stage P2's remote lane).
    pub fn queue_velocity(&mut self, position: WorldPosition, velocity: Vector3) {
        while self.position_queue.len() >= INTERPOLATION_QUEUE_CAP {
            self.position_queue.pop_front();
        }
        self.position_queue
            .push_back(InterpolationNode::velocity_node(position, velocity));
    }

    /// `InterpolationManager::NodeCompleted(success)`
    /// (`acclient.c:388882-388946`): reset the progress window, pop the
    /// head; re-seed `original_distance` against the new head when it is
    /// a position node; on failure save the popped node's position into
    /// `blipto_position`; an emptied queue with success stops
    /// interpolating.
    pub fn node_completed(&mut self, success: bool, current: WorldPosition) {
        self.frame_counter = 0;
        self.progress_quantum = 0.0;
        let popped = self.position_queue.pop_front();
        match self.position_queue.front() {
            Some(head) if head.node_type == InterpolationNodeType::Position => {
                self.original_distance = current.distance_to(&head.position);
            }
            Some(_) => {
                if !success
                    && let Some(node) = popped
                {
                    self.blipto_position = Some(node.position);
                }
            }
            None => {
                self.original_distance = BIG_DISTANCE;
                if success {
                    self.stop_interpolating();
                } else if let Some(node) = popped {
                    self.blipto_position = Some(node.position);
                }
            }
        }
    }

    /// `InterpolationManager::UseTime` (`acclient.c:389278-389380`) —
    /// the per-frame drain. Emits the physics side effects for the owner
    /// to apply (see [`InterpolationCommand`]).
    ///
    /// - `node_fail_counter > 3` (or a non-empty fail counter with an
    ///   emptied queue): hard recovery — blip to the LAST position node
    ///   in the queue (tail if it is one; otherwise the newest position
    ///   node before a velocity/snap tail, whose velocity is then also
    ///   applied), else to the saved `blipto_position`; stop.
    /// - Velocity-type head: apply `set_velocity`, `NodeCompleted(1)`.
    /// - Snap-type head: `NodeCompleted(1)`.
    /// - Position-type head: left for the per-frame [`Self::step`].
    pub fn use_time(&mut self, current: WorldPosition) -> Vec<InterpolationCommand> {
        let mut commands = Vec::new();
        let recover = self.node_fail_counter > 3
            || (self.position_queue.is_empty() && self.node_fail_counter > 0);
        if recover {
            match self.position_queue.back().copied() {
                Some(tail) if tail.node_type == InterpolationNodeType::Position => {
                    commands.push(InterpolationCommand::SetPosition(tail.position));
                }
                Some(tail) => {
                    // Velocity/snap tail: blip to the newest position
                    // node before it (`:389320-389352`), then apply the
                    // tail velocity.
                    let last_position = self
                        .position_queue
                        .iter()
                        .filter(|node| node.node_type == InterpolationNodeType::Position)
                        .next_back()
                        .map(|node| node.position);
                    if let Some(pos) = last_position {
                        commands.push(InterpolationCommand::SetPosition(pos));
                        commands.push(InterpolationCommand::SetVelocity(tail.velocity));
                    } else if let Some(blip) = self.blipto_position {
                        commands.push(InterpolationCommand::SetPosition(blip));
                    }
                }
                None => {
                    if let Some(blip) = self.blipto_position {
                        commands.push(InterpolationCommand::SetPosition(blip));
                    }
                }
            }
            self.stop_interpolating();
            return commands;
        }

        match self.position_queue.front().copied() {
            Some(head) if head.node_type == InterpolationNodeType::Velocity => {
                commands.push(InterpolationCommand::SetVelocity(head.velocity));
                self.node_completed(true, current);
            }
            Some(head) if head.node_type == InterpolationNodeType::Snap => {
                self.node_completed(true, current);
            }
            _ => {}
        }
        commands
    }

    /// `InterpolationManager::adjust_offset` for a position-type head
    /// node (`acclient.c:389178-389276`), the queue generalization of
    /// [`RetailForcePositionInterpolator::step`]'s interpolation half.
    /// The constraint scaling belongs to [`ConstraintManager`]; the
    /// [`PositionManager`] facade chains them in retail order
    /// (`PositionManager::adjust_offset`, `acclient.c:388287-388304`).
    ///
    /// On stall: `++node_fail_counter; NodeCompleted(0)` — the node
    /// fails toward blipto recovery instead of silently stopping (the
    /// §3 row-5 gap this stage closes).
    ///
    /// A2-P3: `sticky_active` bypasses the 5-frame progress-test abort
    /// while the owner's sticky target is non-zero — retail's interp
    /// sticky exemption (acclient.c:389243-389245; local sticky and
    /// local force-position coexist).
    #[allow(clippy::too_many_arguments)]
    fn step_position_head(
        &mut self,
        current: WorldPosition,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
        constraint: &mut ConstraintManager,
        sticky_active: bool,
        retail_leash: bool,
    ) -> InterpStep {
        let Some(head) = self.position_queue.front().copied() else {
            return InterpStep::Idle;
        };
        if head.node_type != InterpolationNodeType::Position {
            return InterpStep::Idle;
        }
        // Contact gate (`:389199`).
        if !on_contact {
            return InterpStep::Progressed { pose: current };
        }
        let target = head.position;
        let dist = current.distance_to(&target);
        if dist < RECONCILE_DEADBAND_M {
            self.node_completed(true, current);
            return InterpStep::Completed { pose: current };
        }

        let max_speed = if max_speed < EPSILON {
            MAX_INTERPOLATED_VELOCITY
        } else {
            max_speed
        };

        let delta = self.original_distance - dist;
        self.progress_quantum += quantum;
        self.frame_counter += 1;

        let progressing = delta >= EPSILON
            && self.progress_quantum > EPSILON
            && (delta / self.progress_quantum / max_speed) >= MIN_PROGRESS_RATIO;
        let keep_interpolating =
            self.frame_counter < PROGRESS_WINDOW_FRAMES || progressing || sticky_active;

        if !keep_interpolating {
            // Near-complete stall: `curr_distance < 0.2` completes the
            // node instead of failing it (`:389274-389275`).
            if dist < 0.2 {
                self.node_completed(true, current);
                return InterpStep::Completed { pose: current };
            }
            // Stall: fail toward recovery (`:389271-389273`) — unlike the
            // single-node port, the queue path RECOVERS via use_time.
            self.node_fail_counter += 1;
            self.node_completed(false, current);
            return InterpStep::Failed { pose: current };
        }

        if self.frame_counter >= PROGRESS_WINDOW_FRAMES {
            self.frame_counter = 0;
            self.progress_quantum = 0.0;
            self.original_distance = dist;
        }

        let from = current.global_coords();
        let to = target.global_coords();
        let mut offset = to - from;
        let distance = offset.length();

        if distance <= RECONCILE_DEADBAND_M {
            self.node_completed(true, current);
            let pose = reproject_global_into(to, target);
            return InterpStep::Completed { pose };
        }

        let max_quantum = max_speed * quantum;
        if distance > max_quantum {
            offset = offset * (max_quantum / distance);
        }

        // ConstraintManager::adjust_offset chains AFTER interpolation
        // (`PositionManager::adjust_offset`, `acclient.c:388287-388304`).
        let offset = constraint.adjust_offset(offset, on_contact);

        let stepped_global = from + offset;
        let pose = reproject_global_into(stepped_global, target);
        let rotation = if self.keep_heading {
            current.rotation
        } else if retail_leash {
            // Retail applies the node's full frame delta in ONE frame —
            // the heading SNAPS to the node heading while the position
            // eases (`:389252-389269` subtract2 + combine; keep_heading
            // zeroes the rotation delta instead).
            target.rotation
        } else {
            let progress = (max_speed * quantum) / distance.max(1e-6);
            crate::spatial::force_position_interp::slerp_rotation(
                current.rotation,
                target.rotation,
                progress.min(1.0),
            )
        };
        InterpStep::Progressed {
            pose: WorldPosition { rotation, ..pose },
        }
    }
}

/// A2-P3 (2026-06-12, W3+ S9) — the retail `StickyManager`
/// (acclient.c:388519-388720; ACE `Physics/Managers/StickyManager.cs`),
/// the third `PositionManager` slice: glues the owning body to its
/// sticky target (server `StickToObject` motions — melee attack lock).
///
/// Documented deviations from retail (spec S9 §3 R1):
/// - retail `StickTo` registers with the `TargetManager`
///   (`set_target(0, id, 0.5, 0.5)`, acclient.c:388688); we replace
///   that with an explicit pose feed
///   ([`Self::handle_update_target`] from the scene's entity-pose
///   update sites) — same `Initialized` no-op-until-fed semantics
///   (acclient.c:388691-388720).
/// - the 1.0 s timeout is a COUNTDOWN decremented by the per-frame
///   quantum ([`Self::use_time`]) instead of a wall-clock compare
///   (`cur_time > sticky_timeout_time`, acclient.c:388605-388620) —
///   identical in accumulated sim-time, no clock plumbing across the
///   native/wasm targets.
/// - [`Self::adjust_offset`] returns the ABSOLUTE target heading; the
///   pose-adopt path applies absolutes, where retail writes a heading
///   DELTA into the offset frame combined by `Frame::combine`
///   (acclient.c:388593-388600) — composes to the same heading for a
///   single corrector (spec S9 OPEN Q6).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StickyManager {
    /// Sticky target guid (`StickyManager::target_id`); `None` = inactive.
    target_id: Option<Guid>,
    /// Target physics radius (`CPartArray::GetRadius` analog; `0.0`
    /// fallback per acclient.c:319756-319763 — spec S9 OPEN Q3).
    target_radius: f32,
    /// Stashed target pose; `None` ⇔ ACE `Initialized == false`
    /// (acclient.c:388691-388720) — `adjust_offset` no-ops until fed.
    target_position: Option<WorldPosition>,
    /// Countdown remainder of the 1.0 s [`STICKY_TIME`] window.
    timeout_remaining: f32,
}

impl Default for StickyManager {
    fn default() -> Self {
        Self {
            target_id: None,
            target_radius: 0.0,
            target_position: None,
            timeout_remaining: 0.0,
        }
    }
}

impl StickyManager {
    /// `get_sticky_object_id() != 0` (acclient.c:389243-389245 caller).
    pub fn is_active(&self) -> bool {
        self.target_id.is_some()
    }

    pub fn target_id(&self) -> Option<Guid> {
        self.target_id
    }

    /// `StickyManager::StickTo` (acclient.c:388665-388690; ACE
    /// `StickyManager.cs:71-81`): replace any prior target, drop the
    /// stale pose stash (uninitialized until the next feed), re-arm the
    /// 1.0 s timeout.
    pub fn stick_to(&mut self, target: Guid, target_radius: f32) {
        self.target_id = Some(target);
        self.target_radius = target_radius;
        self.target_position = None;
        self.timeout_remaining = STICKY_TIME;
    }

    /// `StickyManager::HandleUpdateTarget` OK arm
    /// (acclient.c:388691-388720; ACE `StickyManager.cs:53-64`): guid
    /// match → stash the pose (flips `Initialized`); mismatch ignored.
    /// A failed/stale status maps to [`Self::clear_target`] (caller
    /// decides).
    pub fn handle_update_target(&mut self, target: Guid, pose: WorldPosition) {
        if self.target_id == Some(target) {
            self.target_position = Some(pose);
        }
    }

    /// ACE `StickyManager.ClearTarget` (StickyManager.cs:33-41). The
    /// `cancel_moveto` side effect is surfaced as the bool return so
    /// the OWNER clears the server-controlled projection (spec S9 §3
    /// Stage L1 step 4 / risk table row 3: only when sticky was
    /// actually active).
    pub fn clear_target(&mut self) -> bool {
        let was_active = self.target_id.is_some();
        *self = Self::default();
        was_active
    }

    /// `StickyManager::UseTime` (acclient.c:388605-388620; ACE
    /// `StickyManager.cs:83-87`) — countdown form (see the struct doc's
    /// deviation note). Returns `true` when the timeout just cleared an
    /// active target.
    pub fn use_time(&mut self, quantum: f32) -> bool {
        if self.target_id.is_none() {
            return false;
        }
        self.timeout_remaining -= quantum;
        if self.timeout_remaining < 0.0 {
            self.clear_target();
            true
        } else {
            false
        }
    }

    /// `StickyManager::adjust_offset` (acclient.c:388519-388601), the
    /// per-frame pull toward the target. `None` unless a target is set
    /// AND its pose was fed ([`Self::handle_update_target`]).
    ///
    /// Returns `(step, heading_rad)`:
    /// - `step`: the world-space XY step (z ZEROED, acclient.c:388557).
    ///   `mag = cylinder_distance_no_z(my_radius, target_radius) −`
    ///   [`STICKY_RADIUS`] (:388559-388560); `speed = max_speed * 5.0`,
    ///   floor `15.0` when ~0 (:388569-388579); `delta = speed *
    ///   quantum`, capped at `mag` — BOTH signs: already inside the
    ///   standoff gives a NEGATIVE `mag` → the capped step backs off
    ///   (:388580-388591).
    /// - `heading_rad`: the ABSOLUTE heading toward the target in
    ///   radians, normalized to `[0, 2π)` (the `+360` negative wrap of
    ///   :388593-388600 in radian form; see the struct doc deviation).
    ///
    /// NO contact requirement (contrast interp :389199 / constraint
    /// :389478).
    pub fn adjust_offset(
        &self,
        current: &WorldPosition,
        my_radius: f32,
        max_speed: f32,
        quantum: f32,
    ) -> Option<(Vector3, f32)> {
        self.target_id?;
        let target = self.target_position?;

        let from = current.global_coords();
        let to = target.global_coords();
        let mut offset = to - from;
        // Sticky zeroes the z component (acclient.c:388557).
        offset.z = 0.0;
        let planar = offset.length();

        // cylinder_distance_no_z (ACE `Position.CylinderDistanceNoZ`):
        // planar center distance minus both radii.
        let mag = planar - my_radius - self.target_radius - STICKY_RADIUS;

        let mut speed = max_speed * 5.0;
        if speed < EPSILON {
            speed = 15.0;
        }
        let mut delta = speed * quantum;
        if delta >= mag.abs() {
            delta = mag;
        }

        let dir = if planar > EPSILON {
            offset * (1.0 / planar)
        } else {
            Vector3::zero()
        };
        let heading_rad = current.heading_to(&target);
        Some((dir * delta, heading_rad))
    }
}

/// The extracted `ConstraintManager` (`acclient.c:389478-389527`; ACE
/// `ConstraintManager.cs`) — the leash that scales the (already
/// interpolation-written) offset between `start` and `max` and zeroes
/// it past `max`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConstraintManager {
    constrained: bool,
    constraint_start: f32,
    constraint_max: f32,
    constraint_pos_offset: f32,
}

impl Default for ConstraintManager {
    fn default() -> Self {
        Self {
            constrained: false,
            constraint_start: 0.0,
            constraint_max: 0.0,
            constraint_pos_offset: 0.0,
        }
    }
}

impl ConstraintManager {
    /// `ConstraintManager::ConstrainTo` (`acclient.c:389514-389527`).
    pub fn constrain_to(&mut self, distance: f32, start: f32, max: f32) {
        self.constrained = true;
        self.constraint_start = start;
        self.constraint_max = max;
        self.constraint_pos_offset = distance;
    }

    /// `UnConstrain`.
    pub fn unconstrain(&mut self) {
        *self = Self::default();
    }

    pub fn is_constrained(&self) -> bool {
        self.constrained
    }

    /// `IsFullyConstrained` — `0.9 * max < offset`
    /// (`acclient.c:389417-389420`; the `jump_is_allowed` error-71
    /// input). Retail has NO `is_constrained` check; the disarmed state
    /// holds `offset = max = 0.0`, so the result is identical.
    pub fn is_fully_constrained(&self) -> bool {
        self.constraint_pos_offset > 0.9 * self.constraint_max
    }

    /// `ConstraintManager::adjust_offset` (`acclient.c:389478-389512`):
    /// on contact, scale the offset by `(max - off)/(max - start)`
    /// inside the band and zero it past `max`; then ACCUMULATE the
    /// applied step length into the running travel budget
    /// (`constraint_pos_offset = sqrt(...) + constraint_pos_offset`,
    /// `:389506-389510`). The contact gate (`transient_state & 1`,
    /// `:389488`) wraps ONLY the scale/zero arm — an airborne frame
    /// still accumulates. ACE `ConstraintManager.cs:76` REPLACED the
    /// budget with the step length, which parked it below `start`
    /// forever and disabled the whole leash.
    pub fn adjust_offset(&mut self, mut offset: Vector3, on_contact: bool) -> Vector3 {
        if !self.constrained {
            return offset;
        }
        if on_contact {
            if self.constraint_pos_offset < self.constraint_max {
                if self.constraint_pos_offset > self.constraint_start {
                    let span = self.constraint_max - self.constraint_start;
                    if span > EPSILON {
                        let scale = (self.constraint_max - self.constraint_pos_offset) / span;
                        offset = offset * scale;
                    }
                }
            } else {
                offset = Vector3::zero();
            }
        }
        self.constraint_pos_offset += offset.length();
        offset
    }
}

/// The retail per-body `PositionManager` (`acclient.h:30952-30956`,
/// interpolation + constraint slots; sticky arrives with P3/W5).
/// Facade contract (survey A2 §4 P1): with
/// [`USE_POSITION_MANAGER_QUEUE`] OFF every call delegates to the
/// embedded legacy single-node interpolator — byte-identical to
/// pre-P1; ON routes through the node queue.
#[derive(Debug, Clone, PartialEq)]
pub struct PositionManager {
    /// Flag-off path — the shipped single-node port, untouched.
    legacy: RetailForcePositionInterpolator,
    pub interpolation: InterpolationManager,
    pub constraint: ConstraintManager,
    /// A2-P3 sticky slice (acclient.h:30952-30956 third slot). Inert
    /// unless a consumer installs a target — every install site is
    /// gated by [`USE_STICKY_MANAGER`] (gate-at-entry; the slice itself
    /// stays ungated so tests can exercise it directly, the A2-P1
    /// `pub interpolation` pattern).
    pub sticky: StickyManager,
    /// Physics-parity 2026-07-03 (dossier A F9/F12): retail-leash mode —
    /// the constraint stays armed across interp completion
    /// (`:389417`; disarm is `UnConstrain`/re-`ConstrainTo` only) and
    /// the interp heading snaps to the node heading in one frame
    /// (`:389252-389269`). OFF (default) = the shipped auto-release +
    /// heading-slerp behavior, byte-identical. Runtime flag
    /// `?retailLeash` (scene install sites set this).
    retail_leash: bool,
}

impl Default for PositionManager {
    fn default() -> Self {
        Self {
            legacy: RetailForcePositionInterpolator::default(),
            interpolation: InterpolationManager::default(),
            constraint: ConstraintManager::default(),
            sticky: StickyManager::default(),
            retail_leash: false,
        }
    }
}

impl PositionManager {
    /// Arm/disarm retail-leash mode (see the field doc). Sticky to the
    /// manager so both the local facade and the remote surface honor it.
    pub fn set_retail_leash(&mut self, on: bool) {
        self.retail_leash = on;
    }

    pub fn retail_leash(&self) -> bool {
        self.retail_leash
    }

    pub fn is_interpolating(&self) -> bool {
        if USE_POSITION_MANAGER_QUEUE {
            self.interpolation.is_interpolating()
        } else {
            self.legacy.is_interpolating()
        }
    }

    /// The currently-installed force-position target (head position
    /// node on the queue path).
    pub fn target(&self) -> Option<WorldPosition> {
        if USE_POSITION_MANAGER_QUEUE {
            self.interpolation.front().and_then(|node| {
                (node.node_type == InterpolationNodeType::Position).then_some(node.position)
            })
        } else {
            self.legacy.target()
        }
    }

    /// `StopInterpolating` + `UnConstrain` on both paths.
    pub fn stop(&mut self) {
        self.legacy.stop();
        self.interpolation.stop_interpolating();
        self.constraint.unconstrain();
    }

    /// Install the LOCAL-player force-position pair (`ConstrainTo` +
    /// `InterpolateTo`, acclient.c:145210-145218) — same signature and
    /// caller contract as the legacy
    /// [`RetailForcePositionInterpolator::install`]; the scene's blip
    /// gate stays at the call site (sub-blip installs only), so the
    /// queue path passes `blip_distance = INFINITY` here.
    pub fn install_force_position(
        &mut self,
        current: WorldPosition,
        target: WorldPosition,
        start_distance: f32,
        max_distance: f32,
        keep_heading: bool,
    ) -> bool {
        if USE_POSITION_MANAGER_QUEUE {
            let dist = current.distance_to(&target);
            let queued =
                self.interpolation
                    .interpolate_to(current, target, keep_heading, f32::INFINITY);
            if queued {
                self.constraint.constrain_to(dist, start_distance, max_distance);
            } else {
                self.constraint.unconstrain();
            }
            queued
        } else {
            self.legacy
                .install(current, target, start_distance, max_distance, keep_heading)
        }
    }

    /// One per-frame step — retail call order per
    /// `PositionManager::UseTime` (`acclient.c:388267-388284`, drain)
    /// then `adjust_offset` (`:388287-388304`, interpolation →
    /// constraint chain). Returns the legacy-shaped [`InterpStep`] plus
    /// any physics side effects the drain emitted (empty on the legacy
    /// path).
    pub fn step_force_position(
        &mut self,
        current: WorldPosition,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
    ) -> (InterpStep, Vec<InterpolationCommand>) {
        if USE_POSITION_MANAGER_QUEUE {
            self.step_queue(current, quantum, max_speed, on_contact)
        } else {
            (
                // A2-P3: the legacy interp's progress test is bypassed
                // while sticky is active (acclient.c:389243-389245) —
                // `sticky.is_active()` is false unless a gated consumer
                // installed a target, so flag-off this is `step`.
                self.legacy.step_ext(
                    current,
                    quantum,
                    max_speed,
                    on_contact,
                    self.sticky.is_active(),
                ),
                Vec::new(),
            )
        }
    }

    /// The queue step shared by the [`USE_POSITION_MANAGER_QUEUE`] local
    /// path and the A2-P2 remote path — retail call order per
    /// `PositionManager::UseTime` (`acclient.c:388267-388284`, drain)
    /// then `adjust_offset` (`:388287-388304`).
    fn step_queue(
        &mut self,
        current: WorldPosition,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
    ) -> (InterpStep, Vec<InterpolationCommand>) {
        // Retail frame order: the position pipeline's `adjust_offset`
        // runs first (`:320029`); `PositionManager::UseTime` drains at
        // tick END (`:322884`). Step, THEN drain — a recovery blip now
        // lands in the same frame its fail was scored, not one early.
        let step = self.interpolation.step_position_head(
            current,
            quantum,
            max_speed,
            on_contact,
            &mut self.constraint,
            self.sticky.is_active(),
            self.retail_leash,
        );
        let stepped = match step {
            InterpStep::Progressed { pose }
            | InterpStep::Completed { pose }
            | InterpStep::Failed { pose } => pose,
            InterpStep::Idle => current,
        };
        let commands = self.interpolation.use_time(stepped);
        // A drain that blipped (recovery) reports the blip pose as
        // the step outcome so the owner lands the body there.
        if let Some(InterpolationCommand::SetPosition(pos)) = commands.first().copied() {
            return (InterpStep::Completed { pose: pos }, commands);
        }
        if !self.retail_leash
            && matches!(step, InterpStep::Completed { .. })
            && !self.interpolation.is_interpolating()
        {
            // Retail keeps the leash armed until `UnConstrain` /
            // re-`ConstrainTo` (`:389417`); the auto-release stays the
            // flag-off behavior pending the retail_leash rollout.
            self.constraint.unconstrain();
        }
        (step, commands)
    }

    // === A2-P2 (2026-06-12, W3+ S8) — the REMOTE driver surface. =========
    //
    // Remote `MoveOrTeleport` corrections (acclient.c:323451-323498)
    // ALWAYS ride the retail node queue — the legacy single-node
    // interpolator is the LOCAL-player force-position carrier and never
    // holds remote state, so these entries bypass the
    // [`USE_POSITION_MANAGER_QUEUE`] facade const (which only chooses the
    // local path's backend). A2-P3 (sticky) extends this same surface.

    /// True when the QUEUE holds nodes — the remote-driver activity
    /// check ([`Self::is_interpolating`] reports the legacy interpolator
    /// when the facade const is off, which is never the remote carrier).
    pub fn queue_active(&self) -> bool {
        self.interpolation.is_interpolating()
    }

    /// Remote `InterpolateTo` (`acclient.c:323492-323495` call site;
    /// queue semantics `:389017-389173`). Returns `true` when a node was
    /// queued.
    pub fn remote_interpolate_to(
        &mut self,
        current: WorldPosition,
        target: WorldPosition,
        keep_heading: bool,
        blip_distance: f32,
    ) -> bool {
        self.interpolation
            .interpolate_to(current, target, keep_heading, blip_distance)
    }

    /// Remote `ConstrainTo` — the leash the caller anchors on the
    /// object's OWN post-move position (`acclient.c:145223-145227`).
    pub fn remote_constrain_to(&mut self, distance: f32, start: f32, max: f32) {
        self.constraint.constrain_to(distance, start, max);
    }

    /// One per-frame remote step — unconditionally the queue path (see
    /// the section comment above). Same outcome/commands contract as
    /// [`Self::step_force_position`]'s queue arm.
    pub fn step_remote(
        &mut self,
        current: WorldPosition,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
    ) -> (InterpStep, Vec<InterpolationCommand>) {
        self.step_queue(current, quantum, max_speed, on_contact)
    }

    // === A2-P3 (2026-06-12, W3+ S9) — the STICKY surface. ================
    //
    // Ungated like the remote surface above: gate-at-entry — every
    // INSTALL site checks [`USE_STICKY_MANAGER`], so with the const off
    // no target ever exists and these are inert (tests drive them
    // directly, the `pub interpolation` pattern).

    /// `StickyManager::StickTo` through the facade.
    pub fn stick_to(&mut self, target: Guid, target_radius: f32) {
        self.sticky.stick_to(target, target_radius);
    }

    /// Clear the sticky target (retail unstick sites: `MotionDone`
    /// one-shot pop acclient.c:343659, unpack preamble :339518-339519,
    /// timeout :388605-388620). Returns `true` when sticky was active —
    /// the ACE `ClearTarget → cancel_moveto` signal for the owner.
    pub fn unstick(&mut self) -> bool {
        self.sticky.clear_target()
    }

    pub fn sticky_object_id(&self) -> Option<Guid> {
        self.sticky.target_id()
    }

    /// Minimal TargetManager-subset pose feed (spec S9 §3 L1 step 4).
    pub fn sticky_handle_update_target(&mut self, target: Guid, pose: WorldPosition) {
        self.sticky.handle_update_target(target, pose);
    }

    /// Per-frame sticky timeout tick (retail `PositionManager::UseTime`
    /// runs sticky's `UseTime` each frame, acclient.c:388283). `true` =
    /// the 1.0 s window just expired and cleared the target.
    pub fn sticky_use_time(&mut self, quantum: f32) -> bool {
        self.sticky.use_time(quantum)
    }

    /// One per-frame sticky `adjust_offset` applied to the CURRENT
    /// working pose (threaded by the caller — never re-read from a
    /// stale body, spec S9 §3 L3 step 2). Chain position: AFTER interp,
    /// BEFORE the runtime write-back (retail interp → sticky →
    /// constraint, acclient.c:388287-388304; constraint scales XY only
    /// in our chain — heading adopted unscaled, spec S9 OPEN Q6).
    /// `None` while inactive or the target pose is unfed.
    pub fn step_sticky_pose(
        &mut self,
        current: WorldPosition,
        my_radius: f32,
        max_speed: f32,
        quantum: f32,
    ) -> Option<WorldPosition> {
        let (step, heading_rad) = self
            .sticky
            .adjust_offset(&current, my_radius, max_speed, quantum)?;
        let stepped_global = current.global_coords() + step;
        let mut pose = reproject_global_into(stepped_global, current);
        // Heading offset toward the target (acclient.c:388593-388600;
        // absolute-adopt equivalence documented on `StickyManager`).
        pose.rotation = Quaternion::from_heading(heading_rad);
        Some(pose)
    }
}

/// Re-express a global-space point in `reference`'s landblock (same
/// helper contract as the legacy module's private fn).
fn reproject_global_into(global: Vector3, reference: WorldPosition) -> WorldPosition {
    let (lb_x, lb_y) = reference.landblock_coords();
    let local = Vector3::new(
        global.x - (lb_x as f32 * METERS_PER_LANDBLOCK),
        global.y - (lb_y as f32 * METERS_PER_LANDBLOCK),
        global.z,
    );
    WorldPosition {
        landblock_id: reference.landblock_id,
        coords: local,
        rotation: reference.rotation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::guid::Guid;
    use holtburger_common::math::Quaternion;

    fn lb() -> Guid {
        Guid(0x00A9_B400 & 0xFFFF_0000)
    }

    fn pose(x: f32, y: f32, z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: lb(),
            coords: Vector3::new(x, y, z),
            rotation: Quaternion::from_heading(0.0),
        }
    }

    const MAX_SPEED: f32 = 36.0;
    const BLIP: f32 = 100.0;

    #[test]
    fn interpolate_to_queues_and_dedupes_tail_within_deadband() {
        let mut interp = InterpolationManager::default();
        let cur = pose(50.0, 50.0, 0.0);
        assert!(interp.interpolate_to(cur, pose(53.0, 50.0, 0.0), true, BLIP));
        assert_eq!(interp.node_count(), 1);
        // A second target within 0.05 m of the tail REPLACES it
        // (`acclient.c:389052-389063`), not stacks.
        assert!(interp.interpolate_to(cur, pose(53.02, 50.0, 0.0), true, BLIP));
        assert_eq!(interp.node_count(), 1, "tail deduped within deadband");
        // A distinct target stacks.
        assert!(interp.interpolate_to(cur, pose(56.0, 50.0, 0.0), true, BLIP));
        assert_eq!(interp.node_count(), 2);
    }

    #[test]
    fn interpolate_to_caps_queue_at_twenty_dropping_heads() {
        let mut interp = InterpolationManager::default();
        let cur = pose(0.0, 0.0, 0.0);
        for i in 0..25 {
            interp.interpolate_to(cur, pose(10.0 + i as f32, 0.0, 0.0), true, f32::INFINITY);
        }
        assert_eq!(interp.node_count(), INTERPOLATION_QUEUE_CAP);
        // Oldest heads were dropped: the head is target #5 (i=5).
        assert_eq!(interp.front().unwrap().position.coords.x, 15.0);
    }

    #[test]
    fn interpolate_to_beyond_blip_queues_fail4_node_and_use_time_blips() {
        let mut interp = InterpolationManager::default();
        let cur = pose(0.0, 0.0, 0.0);
        let far = pose(150.0, 0.0, 0.0);
        assert!(interp.interpolate_to(cur, far, true, BLIP));
        assert_eq!(interp.node_fail_counter(), 4, "blip-type install");
        let commands = interp.use_time(cur);
        assert_eq!(commands, vec![InterpolationCommand::SetPosition(far)]);
        assert!(!interp.is_interpolating(), "recovery stops interpolating");
    }

    #[test]
    fn use_time_drains_velocity_and_snap_heads() {
        let mut interp = InterpolationManager::default();
        let cur = pose(0.0, 0.0, 0.0);
        let v = Vector3::new(1.0, 2.0, 0.0);
        interp.queue_velocity(pose(5.0, 0.0, 0.0), v);
        let commands = interp.use_time(cur);
        assert_eq!(commands, vec![InterpolationCommand::SetVelocity(v)]);
        assert_eq!(interp.node_count(), 0);
    }

    #[test]
    fn stalled_position_node_fails_toward_blipto_recovery() {
        // A node that makes no progress fails after the 5-frame window;
        // repeated failures push node_fail_counter past 3 and use_time
        // hard-recovers to the SAVED blipto position — the §3 row-5
        // "failed local interp just stops" gap, closed.
        let mut interp = InterpolationManager::default();
        let cur = pose(0.0, 0.0, 0.0);
        let mut constraint = ConstraintManager::default();
        for i in 0..4 {
            let target = pose(3.0 + i as f32, 0.0, 0.0);
            interp.interpolate_to(cur, target, true, BLIP);
            // Never move `cur`: stall for the full window each time.
            let mut failed = false;
            for _ in 0..PROGRESS_WINDOW_FRAMES + 1 {
                match interp.step_position_head(cur, 0.0, MAX_SPEED, true, &mut constraint, false, false)
                {
                    InterpStep::Failed { .. } => {
                        failed = true;
                        break;
                    }
                    InterpStep::Progressed { .. } => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
            assert!(failed, "stall #{i} must fail the node");
        }
        assert!(interp.node_fail_counter() > 3);
        let commands = interp.use_time(cur);
        assert_eq!(
            commands,
            vec![InterpolationCommand::SetPosition(pose(6.0, 0.0, 0.0))],
            "recovery blips to the last failed node's saved position"
        );
        assert!(!interp.is_interpolating());
    }

    #[test]
    fn node_completed_reseeds_original_distance_for_next_position_node() {
        let mut interp = InterpolationManager::default();
        let cur = pose(0.0, 0.0, 0.0);
        interp.interpolate_to(cur, pose(1.0, 0.0, 0.0), true, BLIP);
        interp.interpolate_to(cur, pose(5.0, 0.0, 0.0), true, BLIP);
        interp.node_completed(true, cur);
        assert_eq!(interp.node_count(), 1);
        assert!((interp.original_distance - 5.0).abs() < 1e-5);
    }

    #[test]
    fn queue_path_step_converges_through_multiple_nodes() {
        let mut manager = PositionManager::default();
        let mut cur = pose(53.0, 50.0, 0.0);
        // Drive the QUEUE path directly (the facade honors the const).
        manager
            .interpolation
            .interpolate_to(cur, pose(51.0, 50.0, 0.0), true, BLIP);
        manager
            .interpolation
            .interpolate_to(cur, pose(50.0, 50.0, 0.0), true, BLIP);
        assert_eq!(manager.interpolation.node_count(), 2);

        let mut completed = 0;
        for _ in 0..120 {
            let _ = manager.interpolation.use_time(cur);
            match manager.interpolation.step_position_head(
                cur,
                0.016,
                MAX_SPEED,
                true,
                &mut manager.constraint,
                false,
                false,
            ) {
                InterpStep::Progressed { pose } => cur = pose,
                InterpStep::Completed { pose } => {
                    cur = pose;
                    completed += 1;
                    if !manager.interpolation.is_interpolating() {
                        break;
                    }
                }
                InterpStep::Idle => break,
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(completed, 2, "both queued nodes complete in order");
        assert!(cur.distance_to(&pose(50.0, 50.0, 0.0)) < RECONCILE_DEADBAND_M);
    }

    #[test]
    fn constraint_manager_scales_and_zeroes_offsets() {
        let mut constraint = ConstraintManager::default();
        // Unconstrained: passthrough.
        let offset = Vector3::new(1.0, 0.0, 0.0);
        assert_eq!(constraint.adjust_offset(offset, true), offset);
        // In-band: scale = (4-3)/(4-2) = 0.5.
        constraint.constrain_to(3.0, 2.0, 4.0);
        let scaled = constraint.adjust_offset(offset, true);
        assert!((scaled.x - 0.5).abs() < 1e-6);
        // Past max: zeroed.
        constraint.constrain_to(5.0, 2.0, 4.0);
        assert_eq!(constraint.adjust_offset(offset, true), Vector3::zero());
        // IsFullyConstrained: offset > 0.9*max.
        constraint.constrain_to(3.9, 2.0, 4.0);
        assert!(constraint.is_fully_constrained());
        constraint.constrain_to(1.0, 2.0, 4.0);
        assert!(!constraint.is_fully_constrained());
    }

    /// Physics-parity 2026-07-03 (dossier A F9a / B row 43): the budget
    /// ACCUMULATES applied path length (`:389506-389510`) — with enough
    /// travel the leash ENGAGES (scale, then zero, then
    /// `IsFullyConstrained`), which ACE's replace-semantics never did.
    #[test]
    fn constraint_budget_accumulates_until_leash_engages() {
        let mut constraint = ConstraintManager::default();
        // Seeded at 0 (server pos == current), band 2..4.
        constraint.constrain_to(0.0, 2.0, 4.0);
        let step = Vector3::new(1.0, 0.0, 0.0);
        // Below start: passthrough, budget grows 0→1→2.
        assert_eq!(constraint.adjust_offset(step, true), step);
        assert_eq!(constraint.adjust_offset(step, true), step);
        // Budget 2.0 (== start): still passthrough (`>` gate), → 3.0.
        assert_eq!(constraint.adjust_offset(step, true), step);
        // Budget 3.0, in band: scale = (4-3)/(4-2) = 0.5, → 3.5.
        let scaled = constraint.adjust_offset(step, true);
        assert!((scaled.x - 0.5).abs() < 1e-6);
        // Budget 3.5: scale 0.25, → 3.75...
        let scaled = constraint.adjust_offset(step, true);
        assert!((scaled.x - 0.25).abs() < 1e-6);
        assert!(constraint.is_fully_constrained(), "3.75 > 0.9*4 = 3.6");
        // ...asymptotic to max: never quite zero from scaling alone, but
        // a seed past max zeroes outright (previous test covers it).
        assert!(constraint.is_constrained(), "leash stays armed");
    }

    /// The contact gate (`:389488`) wraps only the scale/zero arm — an
    /// airborne (no-contact) frame applies UNSCALED but still burns
    /// budget.
    #[test]
    fn constraint_accumulates_without_contact_but_does_not_scale() {
        let mut constraint = ConstraintManager::default();
        constraint.constrain_to(3.0, 2.0, 4.0);
        let step = Vector3::new(1.0, 0.0, 0.0);
        // Airborne: no scaling despite being in band...
        assert_eq!(constraint.adjust_offset(step, false), step);
        // ...but the budget grew 3.0 → 4.0: next contact frame zeroes.
        assert_eq!(constraint.adjust_offset(step, true), Vector3::zero());
    }

    /// `original_distance` stays `BIG_DISTANCE` on a fresh queue
    /// (`:388878`) — a zero-progress stall cannot fail the FIRST 5-frame
    /// window (the check auto-passes); the fail lands at frame 10.
    #[test]
    fn first_progress_window_auto_passes_on_fresh_queue() {
        let mut interp = InterpolationManager::default();
        let mut constraint = ConstraintManager::default();
        let cur = pose(0.0, 0.0, 0.0);
        interp.interpolate_to(cur, pose(3.0, 0.0, 0.0), true, BLIP);
        for frame in 1..=9 {
            match interp.step_position_head(cur, 0.016, MAX_SPEED, true, &mut constraint, false, false)
            {
                InterpStep::Progressed { .. } => {}
                other => panic!("frame {frame} must survive the first window, got {other:?}"),
            }
        }
        assert!(matches!(
            interp.step_position_head(cur, 0.016, MAX_SPEED, true, &mut constraint, false, false),
            InterpStep::Failed { .. }
        ));
        assert_eq!(interp.node_fail_counter(), 1);
    }

    /// A stall inside 0.2 m COMPLETES the node instead of failing it
    /// (`:389274-389275`).
    #[test]
    fn stall_within_near_complete_band_completes() {
        let mut interp = InterpolationManager::default();
        let mut constraint = ConstraintManager::default();
        let cur = pose(0.0, 0.0, 0.0);
        interp.interpolate_to(cur, pose(0.15, 0.0, 0.0), true, BLIP);
        let mut completed = false;
        for _ in 0..12 {
            match interp.step_position_head(cur, 0.016, MAX_SPEED, true, &mut constraint, false, false)
            {
                InterpStep::Completed { .. } => {
                    completed = true;
                    break;
                }
                InterpStep::Progressed { .. } => {}
                other => panic!("near-complete stall must not fail, got {other:?}"),
            }
        }
        assert!(completed, "stall inside 0.2 m completes");
        assert_eq!(interp.node_fail_counter(), 0);
        assert!(!interp.is_interpolating());
    }


    // === A2-P3 (W3+ S9) sticky tests =====================================

    fn guid(raw: u32) -> Guid {
        Guid(raw)
    }

    /// Spec S9 §4 tests 1+3 — radii-aware standoff `cyl_dist_no_z − 0.3`,
    /// overshoot caps to `mag` BOTH signs (negative mag backs off,
    /// acclient.c:388581-388588), and the returned step's z is always 0
    /// (:388557).
    #[test]
    fn sticky_adjust_offset_standoff_overshoot_and_zero_z() {
        let mut sticky = StickyManager::default();
        sticky.stick_to(guid(0x1234), 0.7);
        // Target 10 m due +X, 5 m HIGHER — z must not leak into the step.
        sticky.handle_update_target(guid(0x1234), pose(60.0, 50.0, 5.0));
        let cur = pose(50.0, 50.0, 0.0);

        // mag = 10 − 0.5(my) − 0.7(target) − 0.3(STICKY_RADIUS) = 8.5.
        // speed = 2*5 = 10; delta = 10*0.1 = 1.0 < 8.5 → uncapped step.
        let (step, _) = sticky.adjust_offset(&cur, 0.5, 2.0, 0.1).unwrap();
        assert!((step.x - 1.0).abs() < 1e-5);
        assert!(step.y.abs() < 1e-6);
        assert_eq!(step.z, 0.0, "sticky z is zeroed (acclient.c:388557)");

        // Overshoot: delta = 10*1.0 = 10 ≥ 8.5 → capped at mag.
        let (step, _) = sticky.adjust_offset(&cur, 0.5, 2.0, 1.0).unwrap();
        assert!((step.x - 8.5).abs() < 1e-4);

        // Inside the standoff: planar 0.5, mag = 0.5 − 1.5 = −1.0;
        // delta = 1.0 ≥ |−1.0| → delta = mag → backs off (negative X).
        sticky.handle_update_target(guid(0x1234), pose(50.5, 50.0, 0.0));
        let (step, _) = sticky.adjust_offset(&cur, 0.5, 2.0, 0.1).unwrap();
        assert!((step.x + 1.0).abs() < 1e-4, "negative mag backs off: {}", step.x);
        assert_eq!(step.z, 0.0);
    }

    /// Spec S9 §4 test 2 — `max_speed * 5.0`, zero/absent → floor 15.0
    /// (acclient.c:388569-388579).
    #[test]
    fn sticky_speed_model_floors_to_fifteen() {
        let mut sticky = StickyManager::default();
        sticky.stick_to(guid(1), 0.0);
        sticky.handle_update_target(guid(1), pose(60.0, 50.0, 0.0));
        let cur = pose(50.0, 50.0, 0.0);
        // max_speed 0 → speed floors to 15 → delta = 1.5 over 0.1 s.
        let (step, _) = sticky.adjust_offset(&cur, 0.0, 0.0, 0.1).unwrap();
        assert!((step.x - 1.5).abs() < 1e-4, "floor 15: {}", step.x);
        // max_speed 4 → speed 20 → delta = 2.0.
        let (step, _) = sticky.adjust_offset(&cur, 0.0, 4.0, 0.1).unwrap();
        assert!((step.x - 2.0).abs() < 1e-4);
    }

    /// Spec S9 §4 test 4 — absolute heading toward the target,
    /// normalized to `[0, 2π)` (the radian form of retail's negative
    /// `+360` wrap, acclient.c:388597-388600).
    #[test]
    fn sticky_heading_is_absolute_and_wrapped() {
        let mut sticky = StickyManager::default();
        sticky.stick_to(guid(1), 0.0);
        let cur = pose(50.0, 50.0, 0.0);
        let two_pi = std::f32::consts::TAU;
        for (tx, ty) in [(60.0, 50.0), (40.0, 50.0), (50.0, 60.0), (50.0, 40.0), (43.0, 41.0)] {
            sticky.handle_update_target(guid(1), pose(tx, ty, 0.0));
            let (_, heading) = sticky.adjust_offset(&cur, 0.0, 4.0, 0.016).unwrap();
            assert!(
                (0.0..two_pi).contains(&heading),
                "heading {heading} out of [0,2π) for target ({tx},{ty})"
            );
            assert!(
                (heading - cur.heading_to(&pose(tx, ty, 0.0))).abs() < 1e-6,
                "heading must face the target"
            );
        }
    }

    /// Spec S9 §4 test 5 — `use_time` clears strictly after 1.0 s;
    /// `stick_to` re-arms (acclient.c:388605-388620, :388688).
    #[test]
    fn sticky_use_time_clears_after_one_second_and_stick_rearms() {
        let mut sticky = StickyManager::default();
        assert!(!sticky.use_time(10.0), "inactive: no clear signal");
        sticky.stick_to(guid(7), 0.0);
        assert!(!sticky.use_time(0.5));
        assert!(!sticky.use_time(0.5), "exactly 1.0 s accumulated: not yet cleared");
        assert!(sticky.use_time(0.1), "past 1.0 s clears");
        assert!(!sticky.is_active());
        // Re-arm: a fresh stick_to restarts the window.
        sticky.stick_to(guid(7), 0.0);
        assert!(!sticky.use_time(0.9));
        assert!(sticky.is_active());
        assert!(sticky.use_time(0.2));
        assert!(!sticky.is_active());
    }

    /// Spec S9 §4 test 6 — guid mismatch ignored; the pose stash flips
    /// `Initialized`; `adjust_offset` no-ops while uninitialized
    /// (acclient.c:388691-388720).
    #[test]
    fn sticky_handle_update_target_gates_on_guid_and_initialized() {
        let mut sticky = StickyManager::default();
        sticky.stick_to(guid(0xAA), 0.0);
        let cur = pose(50.0, 50.0, 0.0);
        assert!(sticky.adjust_offset(&cur, 0.0, 4.0, 0.016).is_none(), "uninitialized no-op");
        sticky.handle_update_target(guid(0xBB), pose(60.0, 50.0, 0.0));
        assert!(sticky.adjust_offset(&cur, 0.0, 4.0, 0.016).is_none(), "mismatch ignored");
        sticky.handle_update_target(guid(0xAA), pose(60.0, 50.0, 0.0));
        assert!(sticky.adjust_offset(&cur, 0.0, 4.0, 0.016).is_some(), "fed → active");
        // stick_to replaces the prior target and DROPS the stale stash.
        sticky.stick_to(guid(0xCC), 0.0);
        assert!(sticky.adjust_offset(&cur, 0.0, 4.0, 0.016).is_none());
    }

    /// Spec S9 §4 test 7 — a fresh facade is inert with no sticky installed:
    /// every sticky site early-outs regardless of `USE_STICKY_MANAGER` (which
    /// ships ON since a7cfb75e, "enable full unified pipeline"). This lane
    /// verifies the no-install inert path (flag-independent by construction).
    #[test]
    fn sticky_facade_inert_without_install() {
        let mut manager = PositionManager::default();
        assert_eq!(manager.sticky_object_id(), None);
        assert!(!manager.sticky_use_time(10.0));
        assert!(
            manager.step_sticky_pose(pose(50.0, 50.0, 0.0), 0.0, 4.0, 0.016).is_none(),
            "no sticky installed → no step"
        );
        assert!(!manager.unstick(), "nothing to clear");
    }

    /// Spec S9 §4 test 8 — the interp progress-test sticky exemption
    /// (acclient.c:389243-389245): a stalled node does NOT fail while
    /// sticky is active, on BOTH the queue path and the legacy path.
    #[test]
    fn interp_progress_test_exempted_while_sticky_active() {
        // Queue path.
        let mut interp = InterpolationManager::default();
        let mut constraint = ConstraintManager::default();
        let cur = pose(0.0, 0.0, 0.0);
        interp.interpolate_to(cur, pose(3.0, 0.0, 0.0), true, BLIP);
        for _ in 0..(PROGRESS_WINDOW_FRAMES * 4) {
            match interp.step_position_head(cur, 0.016, MAX_SPEED, true, &mut constraint, true, false)
            {
                InterpStep::Progressed { .. } => {}
                other => panic!("sticky-active stall must keep interpolating, got {other:?}"),
            }
        }
        assert_eq!(interp.node_fail_counter(), 0);

        // Legacy path, threaded through the facade: install force-pos +
        // an (ungated, test-driven) sticky target, then stall.
        let mut manager = PositionManager::default();
        let pose3 = pose(3.0, 0.0, 0.0);
        assert!(manager.install_force_position(cur, pose3, 10.0, 100.0, true));
        manager.stick_to(guid(1), 0.0);
        for _ in 0..(PROGRESS_WINDOW_FRAMES * 4) {
            let (step, _) = manager.step_force_position(cur, 0.016, MAX_SPEED, true);
            match step {
                InterpStep::Progressed { .. } => {}
                other => panic!("legacy sticky-active stall must keep interpolating, got {other:?}"),
            }
        }
        // Unstick → the very next window can fail again (gate restored).
        // The fail now RECOVERS in the same frame (retail drain order,
        // `:320029` step then `:322884` UseTime): the emptied queue with
        // a non-zero fail counter blips to the saved node position, so
        // the observable is Completed-at-the-blip + a SetPosition
        // command, not a bare Failed.
        assert!(manager.unstick());
        let mut recovered = false;
        for _ in 0..(PROGRESS_WINDOW_FRAMES * 4) {
            let (step, commands) = manager.step_force_position(cur, 0.016, MAX_SPEED, true);
            if commands
                .iter()
                .any(|c| matches!(c, InterpolationCommand::SetPosition(_)))
            {
                assert!(
                    matches!(step, InterpStep::Completed { pose } if pose.distance_to(&pose3) < 1e-4),
                    "fail-recovery lands at the failed node's position, got {step:?}"
                );
                recovered = true;
                break;
            }
        }
        assert!(recovered, "without sticky the stall fails and blip-recovers");
        assert!(!manager.is_interpolating());
    }

    /// Facade sticky step applies XY + heading and leaves z untouched
    /// (chain slot: after interp, before write-back — the scene/system
    /// integration is covered in `spatial::tests`).
    #[test]
    fn facade_step_sticky_pose_applies_xy_and_heading() {
        let mut manager = PositionManager::default();
        manager.stick_to(guid(2), 0.0);
        let target = pose(55.0, 50.0, 3.0);
        manager.sticky_handle_update_target(guid(2), target);
        let cur = pose(50.0, 50.0, 1.25);
        let stepped = manager.step_sticky_pose(cur, 0.0, 4.0, 0.016).unwrap();
        assert!(stepped.coords.x > cur.coords.x, "pulled toward target");
        assert_eq!(stepped.coords.z, cur.coords.z, "z untouched");
        let expected_heading = cur.heading_to(&target);
        assert!((stepped.rotation.to_heading() - expected_heading).abs() < 1e-3);
    }

    /// Facade ↔ legacy byte-identity for a single force-position install:
    /// stepping the facade matches a bare legacy interpolator step-for-step.
    /// `USE_POSITION_MANAGER_QUEUE` ships ON since a7cfb75e; for a single
    /// install with no dedupe/cap pressure the queue delegates to the same
    /// retail node, so the per-step output stays identical (if a future queue
    /// change diverges here, gate this lane on the const instead).
    #[test]
    fn facade_matches_legacy_interpolator_single_install() {
        let start = pose(53.0, 50.0, 0.0);
        let target = pose(50.0, 50.0, 0.0);

        let mut manager = PositionManager::default();
        let mut legacy = RetailForcePositionInterpolator::default();
        assert_eq!(
            manager.install_force_position(start, target, 10.0, 100.0, true),
            legacy.install(start, target, 10.0, 100.0, true)
        );

        let mut cur_manager = start;
        let mut cur_legacy = start;
        for _ in 0..30 {
            let (step_m, commands) =
                manager.step_force_position(cur_manager, 0.016, MAX_SPEED, true);
            let step_l = legacy.step(cur_legacy, 0.016, MAX_SPEED, true);
            assert!(commands.is_empty(), "legacy path emits no commands");
            assert_eq!(step_m, step_l, "facade must be byte-identical flag-off");
            match step_m {
                InterpStep::Progressed { pose } => {
                    cur_manager = pose;
                }
                InterpStep::Completed { .. } | InterpStep::Failed { .. } | InterpStep::Idle => {
                    break;
                }
            }
            match step_l {
                InterpStep::Progressed { pose } => cur_legacy = pose,
                _ => break,
            }
        }
        assert_eq!(manager.is_interpolating(), legacy.is_interpolating());
    }
}
