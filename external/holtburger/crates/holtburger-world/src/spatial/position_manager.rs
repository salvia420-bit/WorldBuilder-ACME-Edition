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
use holtburger_common::math::Vector3;
use holtburger_common::position::{METERS_PER_LANDBLOCK, WorldPosition};
use std::collections::VecDeque;

/// A2-P1 queue gate (survey A2 §4 Stage P1) — OFF (default): the
/// [`PositionManager`] facade delegates every call to the legacy
/// single-node [`RetailForcePositionInterpolator`], byte-identical to
/// the pre-P1 behavior. ON: force-position installs route through the
/// retail node QUEUE (`interpolate_to` dedupe/cap, `use_time` drain,
/// fail→blipto recovery). Rust const (url-flags.md §6 pattern):
/// flipping means editing this source + wasm rebuild.
pub const USE_POSITION_MANAGER_QUEUE: bool = false;

/// `BIG_DISTANCE` (`acclient.c:41537`) — `original_distance` idle seed.
pub const BIG_DISTANCE: f32 = 999_999.0;

/// Queue cap — `InterpolateTo` pops HEAD nodes while the queue holds
/// `>= 0x14` (`acclient.c:389071`).
pub const INTERPOLATION_QUEUE_CAP: usize = 20;

/// `PhysicsGlobals.EPSILON`.
const EPSILON: f32 = 1e-4;

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
                if self.position_queue.is_empty() {
                    self.original_distance = current.distance_to(&target);
                }
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
    #[allow(clippy::too_many_arguments)]
    fn step_position_head(
        &mut self,
        current: WorldPosition,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
        constraint: &mut ConstraintManager,
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

        let progressing = delta > EPSILON
            && self.progress_quantum > EPSILON
            && (delta / self.progress_quantum / max_speed) >= MIN_PROGRESS_RATIO;
        let keep_interpolating = self.frame_counter < PROGRESS_WINDOW_FRAMES || progressing;

        if !keep_interpolating {
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
        let offset = constraint.adjust_offset(offset);

        let stepped_global = from + offset;
        let pose = reproject_global_into(stepped_global, target);
        let rotation = if self.keep_heading {
            current.rotation
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

    /// `IsFullyConstrained` — `offset > 0.9 * max`
    /// (`acclient.c:~389460`; the `jump_is_allowed` error-71 input).
    pub fn is_fully_constrained(&self) -> bool {
        self.constrained && self.constraint_pos_offset > 0.9 * self.constraint_max
    }

    /// `ConstraintManager::adjust_offset` (`acclient.c:389478-389512`):
    /// scale the offset by `(max - off)/(max - start)` inside the band,
    /// zero it past `max`, then re-evaluate the running offset to this
    /// frame's applied step length (retail line `:389506-389510`).
    pub fn adjust_offset(&mut self, mut offset: Vector3) -> Vector3 {
        if !self.constrained {
            return offset;
        }
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
        self.constraint_pos_offset = offset.length();
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
}

impl Default for PositionManager {
    fn default() -> Self {
        Self {
            legacy: RetailForcePositionInterpolator::default(),
            interpolation: InterpolationManager::default(),
            constraint: ConstraintManager::default(),
        }
    }
}

impl PositionManager {
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
                self.legacy.step(current, quantum, max_speed, on_contact),
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
        let commands = self.interpolation.use_time(current);
        // A drain that blipped (recovery) reports the blip pose as
        // the step outcome so the owner lands the body there.
        if let Some(InterpolationCommand::SetPosition(pos)) = commands.first().copied() {
            return (InterpStep::Completed { pose: pos }, commands);
        }
        let step = self.interpolation.step_position_head(
            current,
            quantum,
            max_speed,
            on_contact,
            &mut self.constraint,
        );
        if matches!(step, InterpStep::Completed { .. }) && !self.interpolation.is_interpolating() {
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
                match interp.step_position_head(cur, 0.0, MAX_SPEED, true, &mut constraint) {
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
        assert_eq!(constraint.adjust_offset(offset), offset);
        // In-band: scale = (4-3)/(4-2) = 0.5.
        constraint.constrain_to(3.0, 2.0, 4.0);
        let scaled = constraint.adjust_offset(offset);
        assert!((scaled.x - 0.5).abs() < 1e-6);
        // Past max: zeroed.
        constraint.constrain_to(5.0, 2.0, 4.0);
        assert_eq!(constraint.adjust_offset(offset), Vector3::zero());
        // IsFullyConstrained: offset > 0.9*max.
        constraint.constrain_to(3.9, 2.0, 4.0);
        assert!(constraint.is_fully_constrained());
        constraint.constrain_to(1.0, 2.0, 4.0);
        assert!(!constraint.is_fully_constrained());
    }

    /// Flag-off facade byte-identity: install/step through the facade
    /// matches a bare legacy interpolator step-for-step.
    #[test]
    fn facade_flag_off_matches_legacy_interpolator() {
        assert!(
            !USE_POSITION_MANAGER_QUEUE,
            "this lane asserts the DEFAULT-OFF facade contract"
        );
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
