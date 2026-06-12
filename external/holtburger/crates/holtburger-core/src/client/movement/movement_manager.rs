//! A3-D3 (2026-06-12, unified movement pipeline STAGE 3) — the
//! `MovementManager` facade + `unpack_movement` semantics. One manager
//! per physics object (retail `MovementManager`,
//! `~/ac-headers/acclient.c:339175-339439`; ACE
//! `Physics/Managers/MovementManager.cs:9-178`): lazily creates its
//! `CMotionInterp` (always running `enter_default_state` first,
//! acclient.c:339192-339199) and `MoveToManager` children and fans
//! events out per the retail table. The registry
//! (`MovementSystem::movement_managers`) keys managers per-entity —
//! per-entity `my_run_rate`, the F3-5 no-globals rule (DESIGN.md
//! "STAGE 3 AMENDMENT").
//!
//! `apply_unpacked_movement` is the core deliverable: the
//! `MovementManager::unpack_movement` port (acclient.c:339492-339621)
//! over our already-decoded `MovementEventData` — pure, returning
//! [`UnpackEffects`] instead of touching physics inline (our physics
//! owner is the integrator + JS rig, not a `CPhysicsObj`).

use super::interp_state::InterpretedState;
use super::motion_interp::{
    MotionInterp, MotionMovementStruct, MotionSideEffects, interpreted_state_from_wire,
};
use super::motion_table_manager::MotionTableManager;
use super::move_to::{MoveToDriveOutput, MoveToManager, MoveToView};
use super::params::MovementParameters;
use holtburger_common::Guid;
use holtburger_protocol::messages::movement::messages::motion::Origin;
use holtburger_protocol::messages::{MovementEventData, MovementType, MovementTypeData};

/// A3-D3 master gate — `unpack_movement` Stage-3 semantics (the DoMotion
/// lattice on style change, per-entity `my_run_rate` install, MoveTo
/// directive recording, standing_longjump consume, preamble
/// cancel/unstick). Default OFF: the new structs are inert dead code —
/// `MovementSystem::apply_movement_world_events` early-returns and
/// nothing is constructed. Wasm coupling: on wasm these semantics are
/// additionally behind `?wireStatePacks=stage1` (A13-W1) — without
/// stage1, UpdateMotion never reaches `holtburger_world::handlers` and
/// D3 is inert by construction. Flip + wasm rebuild + 1070 eye-test
/// before defaulting on (see url-flags.md §6).
pub(crate) const USE_UNPACK_MOVEMENT_SEMANTICS: bool = false;

/// `WeenieError.ActionCancelled = 0x36` — what `CPhysicsObj::
/// cancel_moveto` reports into `MoveToManager::CancelMoveTo` (ACE
/// `PhysicsObj.cancel_moveto`; WeenieError.cs:120).
const WEENIE_ERROR_ACTION_CANCELLED: u32 = 0x36;

/// `GeneralMovementFailure = 0x47` (71) — the facade's default arm
/// (acclient.c:339213; WeenieError.cs:171).
#[allow(dead_code)] // staged: input-lane callers (the typed enums make it unreachable today)
pub(crate) const WEENIE_ERROR_GENERAL_MOVEMENT_FAILURE: u32 = 71;

/// Retail `MovementStruct` — the full 9-type union the facade
/// dispatches (types 1-5 → motion interpreter, 6-9 → MoveToManager,
/// acclient.c:339175-339218).
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)] // staged: input-lane callers arrive with the Stage-3 driver / A14-I2
pub(crate) enum MovementStruct {
    /// Types 1-5 (`CMotionInterp::PerformMovement` subset).
    Motion(MotionMovementStruct),
    /// Type 6. `object_radius`/`object_height` are the caller-resolved
    /// target physics dims (retail `MovementStruct.radius/height`,
    /// `MoveToManager::PerformMovement` case 6 acclient.c:346129-346131;
    /// resolution `CPhysicsObj::MoveToObject` :319808-319817, 0.0
    /// fallback) — A3-D3 driver / S10 §2.4 contract.
    MoveToObject {
        target: Guid,
        target_exists: bool,
        origin: Origin,
        object_radius: f32,
        object_height: f32,
        params: MovementParameters,
    },
    /// Type 7.
    MoveToPosition {
        origin: Origin,
        params: MovementParameters,
    },
    /// Type 8.
    TurnToObject {
        target: Guid,
        target_exists: bool,
        params: MovementParameters,
    },
    /// Type 9.
    TurnToHeading { params: MovementParameters },
}

/// The physics-domain effects `apply_unpacked_movement` returns instead
/// of performing inline (spec D3-3): the caller (the `MovementSystem`
/// consumer / tests) applies them in core's domain. `motion_errors` are
/// DIAGNOSTIC ONLY — the server is authoritative; a lattice rejection
/// here never blocks the wire state.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct UnpackEffects {
    /// Always true (preamble, acclient.c:339518).
    pub cancel_moveto: bool,
    /// Always true (preamble, acclient.c:339519).
    pub unstick: bool,
    /// Case 0, `flags & 0x01` — stick AFTER the state move
    /// (acclient.c:339557-339559).
    pub stick_to: Option<Guid>,
    /// The expanded style the lattice ran `DoMotion` for, when it
    /// changed (acclient.c:339541-339542).
    pub style_do_motion: Option<u32>,
    /// Case 0 only: `flags & 0x02` (`word & 0x200`,
    /// acclient.c:339560).
    pub standing_longjump: Option<bool>,
    /// Lattice rejections (style-gate 63-66, action-cap 69, …).
    pub motion_errors: Vec<u32>,
}

/// One `MovementManager` per physics object. The A4-Q1
/// `MotionTableManager` instance is per-entity here exactly as the
/// Stage-3 DESIGN amendment calls for ("per-entity instances arrive
/// with Stage 3") — the local player's `MovementSystem`-level instance
/// (A4-Q1) stays the rig-lane pump; this one is the lattice's
/// completion spine for the registry entry.
#[derive(Debug, Default)]
pub(crate) struct MovementManager {
    motion_interp: Option<MotionInterp>,
    move_to: Option<MoveToManager>,
    motion_table_manager: MotionTableManager,
    /// RECORDED sticky effect for the A2-P3 owner (W5) — D3 does not
    /// move the JS sticky pin (F3-4 stays untouched); this getter is the
    /// future owner's input.
    sticky_target: Option<Guid>,
}

impl MovementManager {
    /// Lazy `CMotionInterp::Create` + `enter_default_state` — retail
    /// ALWAYS default-states a fresh interpreter
    /// (acclient.c:339192-339199, :339221-339236; ACE
    /// `MovementManager.cs:33-56`). The `InitializeMotionTables` analog
    /// is the A4-Q1 `initialize_state` Ready seed (DESIGN.md:101-102;
    /// num_anims 0 = no table resolved at this layer).
    fn minterp(&mut self) -> &mut MotionInterp {
        if self.motion_interp.is_none() {
            let mut interp = MotionInterp::default();
            interp.enter_default_state();
            self.motion_table_manager.initialize_state(0);
            self.motion_interp = Some(interp);
        }
        self.motion_interp.as_mut().expect("just created")
    }

    /// Lazy `MakeMoveToManager` (acclient.c:339203-339211; ACE
    /// `MovementManager.cs:111-115`).
    fn moveto(&mut self) -> &mut MoveToManager {
        self.move_to.get_or_insert_with(MoveToManager::default)
    }

    /// `MovementManager::PerformMovement` (acclient.c:339175-339218):
    /// types 1-5 → lazy minterp, 6-9 → lazy moveto. The retail
    /// `default → 71` arm is unreachable through the typed enum; kept
    /// as the documented error constant
    /// ([`WEENIE_ERROR_GENERAL_MOVEMENT_FAILURE`]).
    #[allow(dead_code)] // staged: input-lane callers (Stage-3 driver / A14-I2)
    pub(crate) fn perform_movement(
        &mut self,
        mvs: &MovementStruct,
        on_walkable_contact: bool,
        inq_run_rate: Option<f32>,
        effects: &mut MotionSideEffects,
    ) -> Result<(), u32> {
        match mvs {
            MovementStruct::Motion(motion_mvs) => {
                // Split borrow: the interpreter and its completion spine
                // are sibling fields.
                if self.motion_interp.is_none() {
                    self.minterp();
                }
                let interp = self.motion_interp.as_mut().expect("created above");
                interp.perform_movement(
                    motion_mvs,
                    on_walkable_contact,
                    inq_run_rate,
                    &mut self.motion_table_manager,
                    effects,
                )
            }
            MovementStruct::MoveToObject {
                target,
                target_exists,
                origin,
                object_radius,
                object_height,
                params,
            } => {
                // Retail MoveToManager::PerformMovement preamble:
                // CancelMoveTo(0x36) before every 6-9 install
                // (acclient.c:346123-346127); the CleanUp stop set
                // rides the lattice (A3-D3 driver).
                self.cancel_moveto_with_effects(
                    WEENIE_ERROR_ACTION_CANCELLED,
                    on_walkable_contact,
                    effects,
                );
                let moveto = self.moveto();
                if *target_exists {
                    moveto.move_to_object(
                        *target,
                        origin.clone(),
                        *object_radius,
                        *object_height,
                        *params,
                    );
                } else {
                    // Retail LABEL_15 fallback (acclient.c:339572-339585).
                    moveto.move_to_position(origin.clone(), *params);
                }
                Ok(())
            }
            MovementStruct::MoveToPosition { origin, params } => {
                self.cancel_moveto_with_effects(
                    WEENIE_ERROR_ACTION_CANCELLED,
                    on_walkable_contact,
                    effects,
                );
                self.moveto().move_to_position(origin.clone(), *params);
                Ok(())
            }
            MovementStruct::TurnToObject {
                target,
                target_exists,
                params,
            } => {
                self.cancel_moveto_with_effects(
                    WEENIE_ERROR_ACTION_CANCELLED,
                    on_walkable_contact,
                    effects,
                );
                let moveto = self.moveto();
                if *target_exists {
                    moveto.turn_to_object(*target, *params);
                } else {
                    moveto.turn_to_heading(*params);
                }
                Ok(())
            }
            MovementStruct::TurnToHeading { params } => {
                self.cancel_moveto_with_effects(
                    WEENIE_ERROR_ACTION_CANCELLED,
                    on_walkable_contact,
                    effects,
                );
                self.moveto().turn_to_heading(*params);
                Ok(())
            }
        }
    }

    /// A3-D3 driver — apply a [`MoveToDriveOutput`]'s `_StopMotion` /
    /// `_DoMotion` requests through the landed lattice (retail
    /// `MoveToManager::_DoMotion`/`_StopMotion`,
    /// acclient.c:344753-344831: `adjust_motion` then
    /// `Do/StopInterpretedMotion` — NOT the style-gated `DoMotion`
    /// entry). Returns the FIRST `_DoMotion` error (retail
    /// BeginMoveForward/BeginTurnToHeading cancel on it,
    /// :345417-345418); stop errors are dropped exactly as retail's
    /// CleanUp ignores them.
    fn apply_moveto_lattice(
        &mut self,
        out: &MoveToDriveOutput,
        on_walkable_contact: bool,
        effects: &mut MotionSideEffects,
    ) -> Option<u32> {
        if out.stop_motions.is_empty() && out.do_motions.is_empty() {
            return None;
        }
        if self.motion_interp.is_none() {
            self.minterp();
        }
        // Split borrow: interpreter + per-entity completion spine.
        let interp = self.motion_interp.as_mut().expect("created above");
        for (motion, params) in &out.stop_motions {
            let mut adjusted_motion = *motion;
            let mut adjusted_params = *params;
            interp.adjust_motion_command(
                &mut adjusted_motion,
                &mut adjusted_params.speed,
                params.hold_key_to_apply,
                None,
            );
            let _ = interp.stop_interpreted_motion(
                adjusted_motion,
                &adjusted_params,
                on_walkable_contact,
                &mut self.motion_table_manager,
                effects,
            );
        }
        let mut first_error = None;
        for (motion, params) in &out.do_motions {
            let mut adjusted_motion = *motion;
            let mut adjusted_params = *params;
            interp.adjust_motion_command(
                &mut adjusted_motion,
                &mut adjusted_params.speed,
                params.hold_key_to_apply,
                None,
            );
            if let Err(error) = interp.do_interpreted_motion(
                adjusted_motion,
                &adjusted_params,
                on_walkable_contact,
                &mut self.motion_table_manager,
                effects,
            ) && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        first_error
    }

    /// A3-D3 driver — `CancelMoveTo(error)` with the CleanUp stop set
    /// applied through the lattice synchronously (retail inline
    /// `_StopMotion`, acclient.c:345148-345164). No-op (default
    /// output) when no movement is active.
    pub(crate) fn cancel_moveto_with_effects(
        &mut self,
        error: u32,
        on_walkable_contact: bool,
        effects: &mut MotionSideEffects,
    ) -> MoveToDriveOutput {
        let Some(moveto) = self.move_to.as_mut() else {
            return MoveToDriveOutput::default();
        };
        let out = moveto.cancel_moveto(error);
        self.apply_moveto_lattice(&out, on_walkable_contact, effects);
        out
    }

    /// A3-D3 driver — the facade `UseTime` (acclient.c:339359-339365 →
    /// :346018): run the pure state machine over the caller-built
    /// view, route its `_DoMotion`/`_StopMotion` requests through the
    /// lattice, and cancel-with-error on a `_DoMotion` rejection
    /// (retail :345417-345418). The returned output carries the
    /// world-facing edges (steer/snap/stop/stick/completion) for the
    /// `MovementSystem` shim.
    pub(crate) fn use_time_moveto(
        &mut self,
        view: &MoveToView,
        effects: &mut MotionSideEffects,
    ) -> MoveToDriveOutput {
        if self.move_to.is_none() {
            return MoveToDriveOutput::default();
        }
        // Per-frame per-entity completion pump — retail runs
        // `MotionTableManager::UseTime` every frame alongside the
        // MoveTo pump (`CPartArray::HandleMovement`,
        // acclient.c:325106-325112): zero-anim heads (the
        // enter_default_state Ready seed AND, since A4/SA4F, every
        // loop-realized locomotion/turn/stop node —
        // `motion_interp::renderer_num_anims`) complete synchronously
        // so they never wedge the driver's `motions_pending` gate.
        // `num_anims > 0` (action-class) nodes complete via the A4
        // per-entity [`Self::animation_done`] feed.
        self.motion_table_manager.use_time();
        let _ = self.drain_completions();
        // Re-read the gate post-pump (the caller sampled it pre-pump).
        let mut view = *view;
        view.motions_pending = self.moveto_motions_pending();
        let view = &view;
        let moveto = self.move_to.as_mut().expect("checked above");
        let mut out = moveto.use_time(view);
        if let Some(error) = self.apply_moveto_lattice(&out, view.on_walkable_contact, effects) {
            let cancel_out = self
                .move_to
                .as_mut()
                .expect("checked above")
                .cancel_moveto(error);
            self.apply_moveto_lattice(&cancel_out, view.on_walkable_contact, effects);
            out.stop_completely |= cancel_out.stop_completely;
            out.completion = cancel_out.completion.or(out.completion);
            out.steer = None;
            out.stick_to = None;
            out.set_heading = None;
        }
        out
    }

    /// S10 A.3 passthrough — retail `is_moving_to`
    /// (acclient.c:344895-344898).
    pub(crate) fn is_moveto_active(&self) -> bool {
        self.move_to.as_ref().is_some_and(|m| m.is_active())
    }

    /// S10 A.4 passthrough — read-clear completion latch.
    pub(crate) fn take_moveto_completion(&mut self) -> Option<u32> {
        self.move_to.as_mut().and_then(|m| m.take_completion())
    }

    /// Shim input: the targeted directive's guid (per-tick target
    /// refresh, the `HandleUpdateTarget` cadence).
    pub(crate) fn moveto_directive_target(&self) -> Option<Guid> {
        self.move_to.as_ref().and_then(|m| m.directive_target())
    }

    /// Shim input: the lattice's `motions_pending` for the view
    /// (acclient.c:343728).
    pub(crate) fn moveto_motions_pending(&self) -> bool {
        self.motion_interp
            .as_ref()
            .is_some_and(|interp| interp.motions_pending())
    }

    /// A4/SA4F (2026-06-12) — the ONE `MotionDone` fan-out for this
    /// manager's two completion spines (shared by [`Self::use_time_moveto`],
    /// [`Self::animation_done`], and the `apply_unpacked_movement` tail
    /// pump, so A4 cannot fork the routing — retail
    /// `CPhysicsObj::MotionDone` fan-out, acclient.c:317097 → :339349):
    /// route each drained `MotionDone` into `interp.motion_done`, OR-ing
    /// the unstick-hook requests. Spec §7 OQ-3 fallback taken: the
    /// caller may DROP the returned unstick bit for remote entities —
    /// remote sticky is the F3-4 JS pin / A2-P3 owner's scope (retail
    /// has no local/remote split to cite; revisit with A2-P3).
    fn drain_completions(&mut self) -> bool {
        let mut unstick = false;
        for event in self.motion_table_manager.drain_events() {
            if let super::motion_table_manager::MotionTableEvent::MotionDone { success, .. } = event
                && let Some(interp) = self.motion_interp.as_mut()
            {
                unstick |= interp.motion_done(success);
            }
        }
        unstick
    }

    /// A4/SA4F (2026-06-12) — the per-entity renderer `AnimationDone`
    /// feed: retail's per-OBJECT chain `AnimDoneHook::Execute(object)` →
    /// `CPhysicsObj::Hook_AnimDone` → `CPartArray::AnimationDone` → that
    /// object's OWN `MotionTableManager::AnimationDone`
    /// (acclient.c:342336-342338 → :317087 → :325080-325086 → :329873 —
    /// there is no global queue in retail). A stray notify on an empty
    /// queue is harmless (the acclient.c:329884 head-null guard inside
    /// `MotionTableManager::animation_done`). Returns the OR-ed
    /// unstick-hook requests (see [`Self::drain_completions`] / OQ-3).
    pub(crate) fn animation_done(&mut self, success: bool) -> bool {
        self.motion_table_manager.animation_done(success);
        self.drain_completions()
    }

    /// `MovementManager::move_to_interpreted_state` — lazy-create-first
    /// (acclient.c:339221-339236).
    pub(crate) fn move_to_interpreted_state(
        &mut self,
        state: &InterpretedState,
        server_actions: &[super::raw_state::RawAction],
        last_move_was_autonomous: bool,
        inq_run_rate: Option<f32>,
    ) {
        self.minterp().move_to_interpreted_state(
            state,
            server_actions,
            last_move_was_autonomous,
            inq_run_rate,
        );
    }

    /// `MovementManager::EnterDefaultState` (acclient.c:339250-339268).
    #[allow(dead_code)] // staged: facade fan-out consumer is the Stage-3 driver / entity lifecycle
    pub(crate) fn enter_default_state(&mut self) {
        self.minterp().enter_default_state();
    }

    /// `MotionDone` → minterp only (acclient.c:339349-339355). Returns
    /// the unstick-hook request.
    #[allow(dead_code)] // staged: A4 per-entity completion pump (Stage-3 follow-on)
    pub(crate) fn motion_done(&mut self, success: bool) -> bool {
        self.motion_interp
            .as_mut()
            .map(|interp| interp.motion_done(success))
            .unwrap_or(false)
    }

    /// `HitGround` → BOTH children (acclient.c:339369-339382; ACE
    /// `MovementManager.cs:66-73`).
    #[allow(dead_code)] // staged: Stage-3 driver / tick-spine fan-out
    pub(crate) fn hit_ground(
        &mut self,
        last_move_was_autonomous: bool,
        inq_run_rate: Option<f32>,
        effects: &mut MotionSideEffects,
    ) {
        if let Some(interp) = self.motion_interp.as_mut() {
            interp.hit_ground(last_move_was_autonomous, inq_run_rate, effects);
        }
        if let Some(moveto) = self.move_to.as_mut() {
            moveto.hit_ground();
        }
    }

    /// `LeaveGround` → minterp (acclient.c:339385-339398 — the decomp's
    /// moveto callee is a garbled vtable thunk; ACE
    /// `MovementManager.cs:103-109` confirms minterp-only with the
    /// moveto half retired).
    #[allow(dead_code)] // staged: Stage-3 driver / tick-spine fan-out
    pub(crate) fn leave_ground(&mut self) {
        if let Some(interp) = self.motion_interp.as_mut() {
            interp.leave_ground();
        }
    }

    /// `ReportExhaustion` → minterp (acclient.c:339421-339434; same
    /// garbled-thunk note as `leave_ground` — ACE
    /// `MovementManager.cs:158-164`).
    #[allow(dead_code)] // staged: A3-D2 exhaustion lane per-entity follow-on
    pub(crate) fn report_exhaustion(
        &mut self,
        last_move_was_autonomous: bool,
        inq_run_rate: Option<f32>,
    ) {
        if let Some(interp) = self.motion_interp.as_mut() {
            interp.report_exhaustion(last_move_was_autonomous, inq_run_rate);
        }
    }

    /// `HandleUpdateTarget` → MoveToManager only
    /// (acclient.c:339631-339639).
    #[allow(dead_code)] // staged: A2-P3 target-update plumbing (W5)
    pub(crate) fn handle_update_target(&mut self, target: Guid, origin: Origin) {
        if let Some(moveto) = self.move_to.as_mut() {
            moveto.handle_update_target(target, origin);
        }
    }

    /// A4-Q3 (2026-06-12) — the motion half of
    /// `CPhysicsObj::exit_world` (acclient.c:322205-322220), in retail
    /// order:
    /// 1. `CPartArray::HandleExitWorld` →
    ///    `MotionTableManager::HandleExitWorld` FIRST
    ///    (acclient.c:322217 → :325128-325136 → :329940-329947) —
    ///    pending-queue drain with `success=0`; its
    ///    `MotionDone(motion, 0)` callbacks re-enter the interp via
    ///    [`Self::drain_completions`], mirroring retail's synchronous
    ///    `CPhysicsObj::MotionDone` fan-out (:317097 → :339349);
    /// 2. THEN `MovementManager::HandleExitWorld` → minterp
    ///    (acclient.c:322220 → :339411-339417; ACE
    ///    `MovementManager.cs:90-94`).
    /// Returns the OR-ed unstick-hook request — the A4-Q3 teleport
    /// trigger DROPS it: retail's `teleport_hook` calls
    /// `PositionManager::UnStick` itself (acclient.c:322250-322252),
    /// so a teleport unsticks by construction.
    pub(crate) fn handle_exit_world(&mut self) -> bool {
        self.motion_table_manager.handle_exit_world();
        let mut unstick = self.drain_completions();
        unstick |= self
            .motion_interp
            .as_mut()
            .map(|interp| interp.handle_exit_world())
            .unwrap_or(false);
        unstick
    }

    /// Recorded sticky target (A2-P3 owner input — F3-4's JS pin is NOT
    /// moved by D3).
    #[allow(dead_code)] // staged: A2-P3 sticky owner (W5)
    pub(crate) fn sticky_target(&self) -> Option<Guid> {
        self.sticky_target
    }

    /// The consumed case-0 `standing_longjump` bit (jump-gate input,
    /// D3-4 follow-on wiring).
    #[allow(dead_code)] // staged: jump-gate follow-on wiring (D3-4)
    pub(crate) fn standing_longjump(&self) -> bool {
        self.motion_interp
            .as_ref()
            .map(|interp| interp.standing_longjump)
            .unwrap_or(false)
    }

    /// Test/diagnostic views.
    #[cfg(test)]
    pub(crate) fn motion_interp_ref(&self) -> Option<&MotionInterp> {
        self.motion_interp.as_ref()
    }

    #[cfg(test)]
    pub(crate) fn move_to_ref(&self) -> Option<&MoveToManager> {
        self.move_to.as_ref()
    }

    /// **The core D3-3 deliverable** — `MovementManager::unpack_movement`
    /// (acclient.c:339492-339621) over the already-decoded
    /// [`MovementEventData`]. Per-unpack, NOT change-gated:
    ///
    /// 1. preamble: cancel_moveto + unstick on EVERY unpack, before any
    ///    gate (`:339518-339519`);
    /// 2. style: expand the wire u16 → full dword (`command_ids_0[]`
    ///    analog) and `DoMotion(style, &MovementParameters::default())`
    ///    when it differs from `InqStyle()` — for ALL movement types,
    ///    BEFORE payload dispatch (`:339540-339542`);
    /// 3. case 0: `move_to_interpreted_state` → stick → standing_longjump
    ///    in exactly that order (`:339546-339560`);
    /// 4. case 6: `my_run_rate` install (`:339571`); missing target →
    ///    MoveToPosition fallback (LABEL_15, `:339572-339585`);
    /// 5. case 7: `my_run_rate` (`:339583`) + MoveToPosition;
    /// 6. case 8: missing target → `desired_heading` + TurnToHeading
    ///    (`:339604-339605`);
    /// 7. case 9: TurnToHeading (`:339614`);
    /// 8. types 1-5: no payload (`:339616-339618`) — the style step
    ///    still ran.
    ///
    /// `target_exists` is computed by the CALLER (core cannot see world
    /// entities at this layer). Contact passes `true` for the lattice
    /// gate: per-entity contact state is not tracked here and the server
    /// is authoritative (`motion_errors` are diagnostics only).
    /// Style expansion uses `MotionStance::from_repr` over the wire u16
    /// (the protocol's closed style table) — NOT
    /// `expand_motion_command_low16`, whose table covers
    /// substate/action classes but no `0x80` style arm (spec OPEN
    /// QUESTION 3, settled here in code); an unknown style id skips the
    /// style step fail-soft.
    pub(crate) fn apply_unpacked_movement(
        &mut self,
        data: &MovementEventData,
        target_exists: bool,
        object_radius: f32,
        object_height: f32,
    ) -> UnpackEffects {
        use holtburger_protocol::messages::movement::MotionStance;

        let mut effects = UnpackEffects {
            cancel_moveto: true,
            unstick: true,
            ..UnpackEffects::default()
        };

        // Preamble (acclient.c:339518-339519): cancel any stored moveto
        // directive + drop the recorded sticky target. The JS-side
        // sticky pin (F3-4) and render motion are untouched — these are
        // the core-domain records. A3-D3 driver: the cancel's CleanUp
        // stop set now rides the lattice (contact `true` — same
        // server-authoritative diagnostic stance as the style step).
        let mut preamble_effects = MotionSideEffects::default();
        self.cancel_moveto_with_effects(WEENIE_ERROR_ACTION_CANCELLED, true, &mut preamble_effects);
        self.sticky_target = None;

        // Style step — all movement types, before payload dispatch.
        if let Some(stance) = MotionStance::from_interpreted(data.current_style) {
            let style = stance as u32;
            if self.minterp().inq_style() != style {
                effects.style_do_motion = Some(style);
                let params = MovementParameters::default();
                let mut side_effects = MotionSideEffects::default();
                // Split borrow for the interpreter + its per-entity
                // completion spine.
                let interp = self.motion_interp.as_mut().expect("minterp() above");
                if let Err(error) = interp.do_motion(
                    style,
                    &params,
                    true,
                    None,
                    &mut self.motion_table_manager,
                    &mut side_effects,
                ) {
                    effects.motion_errors.push(error);
                }
                effects.cancel_moveto |= side_effects.cancel_moveto;
            }
        }

        match (&data.movement_type, &data.data) {
            (MovementType::Invalid, MovementTypeData::Invalid(invalid)) => {
                // Case 0 — retail order: move → stick → longjump
                // (acclient.c:339546-339560). The per-entity manager is
                // server-controlled (`last_move_was_autonomous = false`);
                // the autonomous local player's own re-derive lane stays
                // with its existing owners.
                let (state, actions) = interpreted_state_from_wire(&invalid.state);
                self.move_to_interpreted_state(&state, &actions, false, None);
                if let Some(sticky) = invalid.sticky_object {
                    effects.stick_to = Some(sticky);
                    self.sticky_target = Some(sticky);
                }
                let standing_longjump = data.motion_flags & 0x02 != 0;
                self.minterp().standing_longjump = standing_longjump;
                effects.standing_longjump = Some(standing_longjump);
            }
            (_, MovementTypeData::MoveToObject(moveto)) => {
                self.minterp().my_run_rate = moveto.run_rate;
                let params = MovementParameters::from_wire_moveto(&moveto.params);
                if target_exists {
                    // Wire case 6 dims are CALLER-resolved (the emit
                    // sites compute them next to `target_exists`, 0.0
                    // fallback — retail acclient.c:319810-319815).
                    self.moveto().move_to_object(
                        moveto.target,
                        moveto.origin.clone(),
                        object_radius,
                        object_height,
                        params,
                    );
                } else {
                    self.moveto()
                        .move_to_position(moveto.origin.clone(), params);
                }
            }
            (_, MovementTypeData::MoveToPosition(moveto)) => {
                self.minterp().my_run_rate = moveto.run_rate;
                let params = MovementParameters::from_wire_moveto(&moveto.params);
                self.moveto()
                    .move_to_position(moveto.origin.clone(), params);
            }
            (_, MovementTypeData::TurnToObject(turn)) => {
                let mut params = MovementParameters::from_wire_turnto(&turn.params);
                if target_exists {
                    self.moveto().turn_to_object(turn.target, params);
                } else {
                    params.desired_heading = turn.desired_heading;
                    self.moveto().turn_to_heading(params);
                }
            }
            (_, MovementTypeData::TurnToHeading(turn)) => {
                let params = MovementParameters::from_wire_turnto(&turn.params);
                self.moveto().turn_to_heading(params);
            }
            // Types 1-5 carry the empty Invalid variant with no body
            // bytes (motion.rs:94-101 ↔ acclient.c:339616-339618) — the
            // style step above is all that runs.
            (_, MovementTypeData::Invalid(_)) => {}
        }

        // A4/SA4F (2026-06-12) — tail completion pump: managers WITHOUT
        // an active MoveTo are never pumped by `use_time_moveto` (it
        // early-returns) and `drive_local_moveto` is local-only, so a
        // zero-anim style/stop node enqueued above would otherwise sit
        // and wedge `motions_pending`. Retail completes
        // PerformMovement-issued zero-anim motions the same frame via
        // the synchronous `CheckForCompletedMotions` after every
        // `PerformMovement` arm (acclient.c:344684-344704; the same
        // cadence the system-level pump documents at `system.rs` tick).
        // Unstick requests are dropped here per spec §7 OQ-3 fallback
        // (remote sticky is the F3-4 / A2-P3 owner's scope).
        self.motion_table_manager.use_time();
        let _ = self.drain_completions();

        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::movement::interp_state::{
        InterpretedForwardCommand, MOTION_NONCOMBAT_STYLE,
    };
    use crate::client::movement::motion_interp::{MOTION_READY, PendingMotion};
    use crate::client::movement::move_to::MoveToDirective;
    use holtburger_protocol::messages::movement::messages::motion::{
        MoveToObject, MoveToParameters, MoveToPosition, MovementInvalid, TurnToHeading,
        TurnToObject, TurnToParameters,
    };
    use holtburger_protocol::messages::movement::{InterpretedMotionState, MovementStateFlags};
    use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};

    const STYLE_NONCOMBAT_LOW16: u16 = 0x3D;
    const STYLE_SWORD_LOW16: u16 = 0x3E;
    const STYLE_SWORD: u32 = 0x8000_003E;

    /// Spec §4.6: fixtures go through the REAL decoder — pack the
    /// envelope (`MovementEventData::pack`, motion.rs) and unpack it
    /// back (`unpack`, motion.rs:23-117), asserting the round trip, so
    /// every test consumes wire-shaped data.
    fn roundtrip(data: MovementEventData) -> MovementEventData {
        let mut buf = Vec::new();
        data.pack(&mut buf);
        let mut offset = 0;
        let decoded = MovementEventData::unpack(&buf, &mut offset)
            .expect("fixture must decode through the real unpacker");
        assert_eq!(offset, buf.len(), "decoder must consume the full fixture");
        assert_eq!(decoded, data, "fixture must round-trip bit-exact");
        decoded
    }

    fn envelope(
        movement_type: MovementType,
        motion_flags: u8,
        current_style: u16,
        data: MovementTypeData,
    ) -> MovementEventData {
        roundtrip(MovementEventData {
            guid: Guid(0x8000_0042),
            object_instance_sequence: 1,
            movement_sequence: 2,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type,
            motion_flags,
            current_style,
            data,
        })
    }

    fn case0(motion_flags: u8, sticky: Option<Guid>, style: u16) -> MovementEventData {
        let state = InterpretedMotionState {
            flags: MovementStateFlags::FORWARD_COMMAND | MovementStateFlags::FORWARD_SPEED,
            num_commands: 0,
            current_style: None,
            forward_command: Some(0x0007u16.into()),
            sidestep_command: None,
            turn_command: None,
            forward_speed: Some(1.5),
            sidestep_speed: None,
            turn_speed: None,
            commands: Vec::new(),
        };
        envelope(
            MovementType::Invalid,
            motion_flags,
            style,
            MovementTypeData::Invalid(MovementInvalid {
                state,
                sticky_object: sticky,
            }),
        )
    }

    fn moveto_object(run_rate: f32) -> MovementEventData {
        envelope(
            MovementType::MoveToObject,
            0,
            STYLE_NONCOMBAT_LOW16,
            MovementTypeData::MoveToObject(MoveToObject {
                target: Guid(0x8000_1111),
                origin: Origin::default(),
                params: MoveToParameters::default(),
                run_rate,
            }),
        )
    }

    /// Preamble runs on EVERY unpack — including a repeated identical
    /// message (per-unpack, not change-gated, acclient.c:339518-339519):
    /// the stored moveto directive and the recorded sticky target are
    /// dropped each time.
    #[test]
    fn preamble_fires_on_every_unpack_including_repeats() {
        let mut manager = MovementManager::default();

        // Install a directive + sticky first.
        let moveto = moveto_object(1.5);
        manager.apply_unpacked_movement(&moveto, true, 0.0, 0.0);
        assert!(manager.move_to_ref().unwrap().directive().is_some());
        let sticky_event = case0(0x01, Some(Guid(0x8000_2222)), STYLE_NONCOMBAT_LOW16);
        let effects = manager.apply_unpacked_movement(&sticky_event, false, 0.0, 0.0);
        assert!(
            effects.cancel_moveto && effects.unstick,
            "preamble effects always set"
        );
        assert_eq!(effects.stick_to, Some(Guid(0x8000_2222)));
        assert_eq!(manager.sticky_target(), Some(Guid(0x8000_2222)));
        // The case-0 unpack's own preamble cancelled the directive.
        assert_eq!(manager.move_to_ref().unwrap().directive(), None);

        // A repeated identical non-sticky message still unsticks.
        let plain = case0(0x00, None, STYLE_NONCOMBAT_LOW16);
        let effects = manager.apply_unpacked_movement(&plain, false, 0.0, 0.0);
        assert!(effects.cancel_moveto && effects.unstick);
        assert_eq!(manager.sticky_target(), None);
        let effects = manager.apply_unpacked_movement(&plain, false, 0.0, 0.0);
        assert!(
            effects.cancel_moveto && effects.unstick,
            "repeat still runs the preamble"
        );
    }

    /// Style-DoMotion fires only on a style DELTA, and for ALL movement
    /// types (acclient.c:339540-339542) — types 1-5 included (their
    /// payload is empty, the style step is all that runs).
    #[test]
    fn style_do_motion_on_delta_for_all_types() {
        let mut manager = MovementManager::default();

        // NonCombat == the enter_default_state default → no DoMotion.
        let effects = manager.apply_unpacked_movement(
            &case0(0, None, STYLE_NONCOMBAT_LOW16),
            false,
            0.0,
            0.0,
        );
        assert_eq!(effects.style_do_motion, None);

        // Type-1 (RawCommand, empty payload): style delta still restyles.
        let raw_cmd = envelope(
            MovementType::RawCommand,
            0,
            STYLE_SWORD_LOW16,
            MovementTypeData::Invalid(MovementInvalid::default()),
        );
        let effects = manager.apply_unpacked_movement(&raw_cmd, false, 0.0, 0.0);
        assert_eq!(effects.style_do_motion, Some(STYLE_SWORD));
        assert!(effects.motion_errors.is_empty());
        assert_eq!(
            manager.motion_interp_ref().unwrap().inq_style(),
            STYLE_SWORD,
            "default params carry ModifyInterpretedState → style applied"
        );

        // Same style again → no second DoMotion.
        let effects = manager.apply_unpacked_movement(&raw_cmd, false, 0.0, 0.0);
        assert_eq!(effects.style_do_motion, None);

        // And payload-bearing types restyle too.
        let effects = manager.apply_unpacked_movement(
            &case0(0, None, STYLE_NONCOMBAT_LOW16),
            false,
            0.0,
            0.0,
        );
        assert_eq!(effects.style_do_motion, Some(MOTION_NONCOMBAT_STYLE));
    }

    /// Case-0 effect ORDER move→stick→longjump (acclient.c:339557-339560)
    /// + `motion_flags & 0x02` → standing_longjump both ways.
    #[test]
    fn case0_move_stick_longjump_order_and_flags() {
        let mut manager = MovementManager::default();
        let event = case0(0x01 | 0x02, Some(Guid(0x8000_3333)), STYLE_NONCOMBAT_LOW16);
        let effects = manager.apply_unpacked_movement(&event, false, 0.0, 0.0);

        // Movement copy took effect (server-controlled lane).
        let interp = manager.motion_interp_ref().unwrap();
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::RunForward)
        );
        assert!((interp.interpreted_state.forward_speed - 1.5).abs() < 1e-6);
        // Stick recorded AFTER the move; longjump bit consumed last.
        assert_eq!(effects.stick_to, Some(Guid(0x8000_3333)));
        assert_eq!(effects.standing_longjump, Some(true));
        assert!(manager.standing_longjump());

        // Clearing event: no sticky bit, no longjump bit.
        let effects = manager.apply_unpacked_movement(
            &case0(0x00, None, STYLE_NONCOMBAT_LOW16),
            false,
            0.0,
            0.0,
        );
        assert_eq!(effects.stick_to, None);
        assert_eq!(effects.standing_longjump, Some(false));
        assert!(!manager.standing_longjump());
    }

    /// Case-6/7 `my_run_rate` install with PER-ENTITY isolation (two
    /// managers, two rates — the F3-5 pin, acclient.c:339571/:339583),
    /// and the case-6 missing-target → MoveToPosition LABEL_15 fallback
    /// (acclient.c:339572-339585).
    #[test]
    fn moveto_run_rate_install_per_entity_and_missing_target_fallback() {
        let mut manager_a = MovementManager::default();
        let mut manager_b = MovementManager::default();

        manager_a.apply_unpacked_movement(&moveto_object(1.5), true, 0.0, 0.0);
        manager_b.apply_unpacked_movement(&moveto_object(2.5), true, 0.0, 0.0);
        assert!((manager_a.motion_interp_ref().unwrap().my_run_rate - 1.5).abs() < 1e-6);
        assert!((manager_b.motion_interp_ref().unwrap().my_run_rate - 2.5).abs() < 1e-6);
        assert!(matches!(
            manager_a.move_to_ref().unwrap().directive(),
            Some(MoveToDirective::MoveToObject { target, .. }) if *target == Guid(0x8000_1111)
        ));

        // Missing target (target_exists = false) → MoveToPosition.
        manager_a.apply_unpacked_movement(&moveto_object(1.75), false, 0.0, 0.0);
        assert!((manager_a.motion_interp_ref().unwrap().my_run_rate - 1.75).abs() < 1e-6);
        assert!(matches!(
            manager_a.move_to_ref().unwrap().directive(),
            Some(MoveToDirective::MoveToPosition { .. })
        ));

        // Case 7 installs the rate too.
        let moveto_pos = envelope(
            MovementType::MoveToPosition,
            0,
            STYLE_NONCOMBAT_LOW16,
            MovementTypeData::MoveToPosition(MoveToPosition {
                origin: Origin::default(),
                params: MoveToParameters::default(),
                run_rate: 3.25,
            }),
        );
        manager_b.apply_unpacked_movement(&moveto_pos, false, 0.0, 0.0);
        assert!((manager_b.motion_interp_ref().unwrap().my_run_rate - 3.25).abs() < 1e-6);
    }

    /// Case-8 missing-target → TurnToHeading with the PACKED heading
    /// installed into the params (acclient.c:339604-339605); with a
    /// target → record-only TurnToObject. Case 9 → TurnToHeading.
    #[test]
    fn turnto_target_fallback_uses_packed_heading() {
        let mut manager = MovementManager::default();
        let turn = envelope(
            MovementType::TurnToObject,
            0,
            STYLE_NONCOMBAT_LOW16,
            MovementTypeData::TurnToObject(TurnToObject {
                target: Guid(0x8000_4444),
                desired_heading: 2.5,
                params: TurnToParameters {
                    movement_parameters: 0,
                    speed: 1.0,
                    desired_heading: 0.0,
                },
            }),
        );

        manager.apply_unpacked_movement(&turn, true, 0.0, 0.0);
        assert!(matches!(
            manager.move_to_ref().unwrap().directive(),
            Some(MoveToDirective::TurnToObject { target, .. }) if *target == Guid(0x8000_4444)
        ));

        manager.apply_unpacked_movement(&turn, false, 0.0, 0.0);
        assert!(matches!(
            manager.move_to_ref().unwrap().directive(),
            Some(MoveToDirective::TurnToHeading { params })
                if (params.desired_heading - 2.5).abs() < 1e-6
        ));

        let heading_only = envelope(
            MovementType::TurnToHeading,
            0,
            STYLE_NONCOMBAT_LOW16,
            MovementTypeData::TurnToHeading(TurnToHeading {
                params: TurnToParameters {
                    movement_parameters: 0,
                    speed: 1.0,
                    desired_heading: 1.25,
                },
            }),
        );
        manager.apply_unpacked_movement(&heading_only, false, 0.0, 0.0);
        assert!(matches!(
            manager.move_to_ref().unwrap().directive(),
            Some(MoveToDirective::TurnToHeading { params })
                if (params.desired_heading - 1.25).abs() < 1e-6
        ));
    }

    /// Types 1-5: style step only, no payload effects
    /// (motion.rs:94-101 ↔ acclient.c:339616-339618).
    #[test]
    fn types_1_to_5_run_style_step_only() {
        for movement_type in [
            MovementType::RawCommand,
            MovementType::InterpretedCommand,
            MovementType::StopRawCommand,
            MovementType::StopInterpretedCommand,
            MovementType::StopCompletely,
        ] {
            let mut manager = MovementManager::default();
            let event = envelope(
                movement_type,
                // Flags byte set: must NOT leak into standing_longjump
                // for non-case-0 types.
                0x02,
                STYLE_SWORD_LOW16,
                MovementTypeData::Invalid(MovementInvalid::default()),
            );
            let effects = manager.apply_unpacked_movement(&event, false, 0.0, 0.0);
            assert_eq!(
                effects.style_do_motion,
                Some(STYLE_SWORD),
                "{movement_type:?}"
            );
            assert_eq!(effects.standing_longjump, None, "{movement_type:?}");
            assert_eq!(effects.stick_to, None);
            assert!(
                manager.move_to_ref().is_none(),
                "{movement_type:?} must not create a MoveToManager"
            );
            assert!(!manager.standing_longjump());
        }
    }

    /// Facade fan-out table (§2 cites): hit_ground reaches BOTH
    /// children; leave_ground/report_exhaustion → minterp;
    /// use_time/handle_update_target → moveto only; motion_done →
    /// minterp only.
    #[test]
    fn facade_fan_out_table() {
        let mut manager = MovementManager::default();
        // Seed both children: a longjump case-0 + a moveto directive.
        manager.apply_unpacked_movement(&case0(0x02, None, STYLE_NONCOMBAT_LOW16), false, 0.0, 0.0);
        manager.apply_unpacked_movement(&moveto_object(1.5), true, 0.0, 0.0);

        // hit_ground → both: minterp effect + moveto re-begin marker.
        let mut effects = MotionSideEffects::default();
        manager.hit_ground(false, None, &mut effects);
        assert!(effects.remove_link_animations);
        assert!(manager.move_to_ref().unwrap().pending_hit_ground_rebegin());

        // leave_ground → minterp: clears standing_longjump. (Re-seed the
        // bit first — the moveto unpack above ran the style-free case-6
        // path, longjump survives it.)
        manager.apply_unpacked_movement(&case0(0x02, None, STYLE_NONCOMBAT_LOW16), false, 0.0, 0.0);
        assert!(manager.standing_longjump());
        manager.leave_ground();
        assert!(!manager.standing_longjump());

        // motion_done → minterp only: pops the pending head; an action
        // node reports the unstick hook. A4/SA4F: the tail pump now
        // completes the zero-anim Ready seed inside apply itself, so
        // seed a fresh pending node for the routing check.
        {
            let mut seed_effects = MotionSideEffects::default();
            let interp = manager.motion_interp.as_mut().unwrap();
            interp
                .do_interpreted_motion(
                    MOTION_READY,
                    &MovementParameters::default(),
                    true,
                    &mut manager.motion_table_manager,
                    &mut seed_effects,
                )
                .unwrap();
        }
        let interp = manager.motion_interp_ref().unwrap();
        let head = interp.pending_motions.front().copied();
        assert!(head.is_some(), "seeded a Ready pending node");
        assert!(!manager.motion_done(true), "Ready head is not an action");

        // use_time_moveto / handle_update_target → moveto only. An
        // off-ground view keeps the driver inert (contact gate
        // acclient.c:346024) so this exercises the routing without
        // driving.
        let airborne_view = MoveToView {
            on_walkable_contact: false,
            self_pos: holtburger_common::position::WorldPosition::default(),
            self_radius: 0.4,
            self_height: 1.8,
            target_pos: None,
            motions_pending: false,
            is_interpolating: false,
            now: web_time::Instant::now(),
        };
        let mut moveto_effects = MotionSideEffects::default();
        let out = manager.use_time_moveto(&airborne_view, &mut moveto_effects);
        assert!(out.do_motions.is_empty() && out.stop_motions.is_empty());
        manager.handle_update_target(Guid(0x8000_5555), Origin::default());
        assert_eq!(
            manager
                .move_to_ref()
                .unwrap()
                .last_target_update()
                .map(|(guid, _)| *guid),
            Some(Guid(0x8000_5555))
        );

        // report_exhaustion → minterp (no-op for the server-controlled
        // arm; must not touch the moveto directive).
        let directive_before = manager.move_to_ref().unwrap().directive().cloned();
        manager.report_exhaustion(false, Some(1.0));
        assert_eq!(
            manager.move_to_ref().unwrap().directive().cloned(),
            directive_before
        );
    }

    /// Lazy minterp creation runs `enter_default_state` exactly once:
    /// one Ready seed node on `pending_motions` + the A4-Q1
    /// `initialize_state` Ready on the per-entity completion spine; a
    /// second unpack does not re-seed. A4/SA4F: the zero-anim Ready
    /// seed now COMPLETES inside the same `apply_unpacked_movement`
    /// call (the tail `use_time` pump — retail's synchronous
    /// `CheckForCompletedMotions` after every `PerformMovement` arm,
    /// acclient.c:344684-344704), so the post-call queue is EMPTY, not
    /// one-deep.
    #[test]
    fn lazy_create_runs_enter_default_state_exactly_once() {
        let mut manager = MovementManager::default();

        // Direct lazy-create (no tail pump): the seed is observable.
        let _ = manager.minterp();
        let interp = manager.motion_interp_ref().unwrap();
        assert!(interp.initted);
        assert_eq!(
            interp.pending_motions.front(),
            Some(&PendingMotion {
                context_id: 0,
                motion: MOTION_READY,
                jump_error_code: 0
            })
        );
        assert_eq!(interp.pending_motions.len(), 1);

        // Through apply: the tail pump completes the zero-anim seed
        // same-call; a second unpack neither re-seeds nor re-pends.
        let mut manager = MovementManager::default();
        let event = case0(0, None, STYLE_NONCOMBAT_LOW16);
        manager.apply_unpacked_movement(&event, false, 0.0, 0.0);
        let interp = manager.motion_interp_ref().unwrap();
        assert!(interp.initted);
        assert!(
            interp.pending_motions.is_empty(),
            "the Ready seed completes via the same-call tail pump"
        );
        assert!(!manager.moveto_motions_pending());

        manager.apply_unpacked_movement(&event, false, 0.0, 0.0);
        assert!(
            manager.motion_interp_ref().unwrap().pending_motions.is_empty(),
            "no re-seed on the second unpack"
        );
    }

    /// A4/SA4F — [`MovementManager::animation_done`] pops BOTH spines
    /// for a tagged action node (the per-entity renderer feed, retail
    /// per-OBJECT chain acclient.c:342336 → :317087 → :325080 →
    /// :329873); an empty-queue notify no-ops (the acclient.c:329884
    /// head-null guard).
    #[test]
    fn animation_done_pops_both_spines_and_noops_when_empty() {
        // Empty-queue notify: harmless no-op (manager not even seeded).
        let mut manager = MovementManager::default();
        assert!(!manager.animation_done(true), "empty notify no-ops");

        // Seed (one Ready on each spine) + enqueue an action-class
        // motion on both spines.
        let _ = manager.minterp();
        {
            let mut effects = MotionSideEffects::default();
            let interp = manager.motion_interp.as_mut().unwrap();
            interp
                .do_interpreted_motion(
                    0x1000_0062,
                    &MovementParameters::default(),
                    true,
                    &mut manager.motion_table_manager,
                    &mut effects,
                )
                .unwrap();
        }
        assert!(manager.moveto_motions_pending());

        // One renderer AnimationDone: pops the zero-anim Ready seed +
        // the {action, 1} node off the mtm spine, routes both
        // MotionDone events into the interp spine (action pop requests
        // the unstick hook, acclient.c:343659).
        assert!(manager.animation_done(true), "action pop bubbles the unstick request");
        assert!(!manager.moveto_motions_pending(), "both spines drained");

        // A second notify on the now-empty queue no-ops again.
        assert!(!manager.animation_done(true));
    }

    /// A4/SA4F — the `apply_unpacked_movement` tail pump completes a
    /// zero-anim style node same-call (retail same-frame
    /// `CheckForCompletedMotions` after every `PerformMovement` arm,
    /// acclient.c:344684-344704): a style delta enqueues `{style, 0}`
    /// (loop-realized — `renderer_num_anims`) and `motions_pending` is
    /// already false on return — no driver pump needed.
    #[test]
    fn apply_unpacked_movement_tail_pump_completes_style_node_same_call() {
        let mut manager = MovementManager::default();
        let event = case0(0, None, STYLE_SWORD_LOW16);
        let effects = manager.apply_unpacked_movement(&event, false, 0.0, 0.0);
        assert_eq!(
            effects.style_do_motion,
            Some(STYLE_SWORD),
            "style delta dispatched through the lattice"
        );
        assert!(
            !manager.moveto_motions_pending(),
            "zero-anim style node completed inside the same apply call"
        );
    }
}
