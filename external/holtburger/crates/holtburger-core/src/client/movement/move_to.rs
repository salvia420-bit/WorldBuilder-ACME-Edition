//! A3-D3-2 (2026-06-12, unified movement pipeline STAGE 3) —
//! `MoveToManager` SKELETON. Declarations mirror retail
//! (`~/ac-headers/acclient.c:7129-7161`; bodies at `:524xxx`; ACE
//! `Physics/Animation/MoveToManager.cs`). Scope-minimal for D3: the
//! manager STORES directives but does not act — the per-frame
//! `UseTime` / `HandleMoveToPosition` driver is the base Stage-3
//! follow-on (A2 owns the position-trio seam, survey A3 §1 / ROADMAP
//! §2). Until that driver lands, the EXISTING render-side consumers
//! (the `handlers/movement.rs` TurnTo heading-set and the JS KIND_TURN
//! fixed-K ease) keep producing motion — no double-driver risk because
//! this skeleton never moves anything.

use super::params::MovementParameters;
use holtburger_common::Guid;
use holtburger_protocol::messages::movement::messages::motion::Origin;

/// The stored movement directive — the `MovementStruct` 6-9 payloads
/// (`MoveToManager::{MoveToObject, MoveToPosition, TurnToObject,
/// TurnToHeading}`, acclient.c unpack cases 6-9). Shape coordinates
/// with A14-I2 (the input-intent seam consumes this entry shape —
/// ROADMAP §2 A2/A3 seam).
// (`Origin` is not `Copy` — protocol struct — so this is Clone-only.)
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MoveToDirective {
    /// Case 6 with a resolvable target (`CPhysicsObj::MoveToObject`,
    /// acclient.c:339574).
    MoveToObject {
        target: Guid,
        origin: Origin,
        params: MovementParameters,
    },
    /// Case 7 — and the case-6 missing-target LABEL_15 fallback
    /// (`MoveToManager::MoveToPosition`, acclient.c:339572-339585).
    MoveToPosition {
        origin: Origin,
        params: MovementParameters,
    },
    /// Case 8 with a resolvable target (`CPhysicsObj::TurnToObject`,
    /// acclient.c:339602) — record-only in D3.
    TurnToObject {
        target: Guid,
        params: MovementParameters,
    },
    /// Case 9 — and the case-8 missing-target fallback with
    /// `params.desired_heading` pre-set (acclient.c:339604-339605).
    TurnToHeading { params: MovementParameters },
}

/// The `MoveToManager` skeleton: one current-directive slot + the
/// bookkeeping the future driver and the A2-P3 target-update plumbing
/// anchor on.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct MoveToManager {
    /// The active directive (retail `movement_type` + sought-target
    /// fields, `MoveToManager::InitializeLocalVariables`).
    directive: Option<MoveToDirective>,
    /// Last `CancelMoveTo(err)` code recorded (diagnostics; retail
    /// reports it to the weenie via `CleanUpAndCallWeenie`).
    last_cancel_error: Option<u32>,
    /// A2-P3 "target-update plumbing" anchor (ROADMAP §2 A2/A3 seam) —
    /// `HandleUpdateTarget` records target position updates here for
    /// the future driver (`MoveToManager::HandleUpdateTarget`,
    /// acclient.c:339631-339639).
    last_target_update: Option<(Guid, Origin)>,
    /// `HitGround` re-begin marker: retail re-begins the pending node
    /// chain on touchdown (`MoveToManager::HitGround` →
    /// `BeginNextNode`); the skeleton records that a re-begin is owed so
    /// the future driver can honor it.
    pending_hit_ground_rebegin: bool,
}

impl MoveToManager {
    /// `MoveToManager::MoveToObject` (ACE `MoveToManager.cs:114-139`) —
    /// store the directive.
    pub(crate) fn move_to_object(
        &mut self,
        target: Guid,
        origin: Origin,
        params: MovementParameters,
    ) {
        self.directive = Some(MoveToDirective::MoveToObject {
            target,
            origin,
            params,
        });
    }

    /// `MoveToManager::MoveToPosition` (ACE `MoveToManager.cs:184+`) —
    /// store the directive (also the case-6 LABEL_15 fallback target).
    pub(crate) fn move_to_position(&mut self, origin: Origin, params: MovementParameters) {
        self.directive = Some(MoveToDirective::MoveToPosition { origin, params });
    }

    /// `CPhysicsObj::TurnToObject` → `MoveToManager::TurnToObject` —
    /// record-only in D3.
    pub(crate) fn turn_to_object(&mut self, target: Guid, params: MovementParameters) {
        self.directive = Some(MoveToDirective::TurnToObject { target, params });
    }

    /// `MoveToManager::TurnToHeading` (acclient.c:339604-339614).
    // A13-W4 TurnToEvent emit hook (design-gated, ROADMAP §8 row 2):
    // S15 ruled NO-GO — ACE has no 0xF649 handler (dead enum entry,
    // InboundMessageManager drops it), so NO send is wired here; heading
    // already flows server-ward via MoveToState 0xF61C +
    // AutonomousPosition 0xF753. Reopen only if upstream ACE adds the
    // handler.
    pub(crate) fn turn_to_heading(&mut self, params: MovementParameters) {
        self.directive = Some(MoveToDirective::TurnToHeading { params });
    }

    /// `MoveToManager::CancelMoveTo(err)` (acclient.c `:5241B0` facade →
    /// manager): drop the directive, record the error.
    pub(crate) fn cancel_moveto(&mut self, error: u32) {
        if self.directive.is_some() {
            self.last_cancel_error = Some(error);
        }
        self.directive = None;
        self.pending_hit_ground_rebegin = false;
    }

    /// `MoveToManager::UseTime` — the per-frame driver. Stage-3 driver
    /// follow-on: deliberately a no-op until the base Stage-3 driver
    /// lands (the legacy TurnTo heading-set + JS KIND_TURN ease keep
    /// producing motion; retiring them belongs to THAT change, not D3).
    #[allow(dead_code)] // staged: Stage-3 driver follow-on
    pub(crate) fn use_time(&mut self) {}

    /// `MoveToManager::HitGround` — retail re-begins the node chain on
    /// touchdown; the skeleton records the owed re-begin.
    #[allow(dead_code)] // staged: facade fan-out consumer is the Stage-3 driver
    pub(crate) fn hit_ground(&mut self) {
        if self.directive.is_some() {
            self.pending_hit_ground_rebegin = true;
        }
    }

    /// `MoveToManager::HandleUpdateTarget` (acclient.c:339631-339639) —
    /// record the target position update (the A2-P3 anchor).
    #[allow(dead_code)] // staged: A2-P3 target-update plumbing (W5)
    pub(crate) fn handle_update_target(&mut self, target: Guid, origin: Origin) {
        self.last_target_update = Some((target, origin));
    }

    /// Active directive view (tests + the future driver).
    #[allow(dead_code)] // staged: the Stage-3 driver is the runtime reader (tests today)
    pub(crate) fn directive(&self) -> Option<&MoveToDirective> {
        self.directive.as_ref()
    }

    /// Diagnostics: last recorded cancel error.
    #[allow(dead_code)] // staged: weenie-callback owner (Stage-3 driver)
    pub(crate) fn last_cancel_error(&self) -> Option<u32> {
        self.last_cancel_error
    }

    /// Whether a `HitGround` re-begin is owed (future driver input).
    #[allow(dead_code)] // staged: Stage-3 driver consumer
    pub(crate) fn pending_hit_ground_rebegin(&self) -> bool {
        self.pending_hit_ground_rebegin
    }

    /// A2-P3 anchor view.
    #[allow(dead_code)] // staged: A2-P3 target-update consumer (W5)
    pub(crate) fn last_target_update(&self) -> Option<&(Guid, Origin)> {
        self.last_target_update.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Origin {
        Origin {
            cell_id: Guid::from(0xA9B4_0001_u32),
            position: holtburger_common::math::Vector3::new(10.0, 20.0, 0.5),
        }
    }

    /// The skeleton stores-but-does-not-act: directives install, a
    /// later directive replaces, `cancel_moveto` clears + records, and
    /// `use_time` never mutates (no driver).
    #[test]
    fn directive_slot_stores_replaces_and_cancels() {
        let mut manager = MoveToManager::default();
        assert_eq!(manager.directive(), None);

        let params = MovementParameters::default();
        manager.move_to_object(Guid::from(0x8000_0001_u32), origin(), params);
        assert!(matches!(
            manager.directive(),
            Some(MoveToDirective::MoveToObject { .. })
        ));

        manager.turn_to_heading(MovementParameters {
            desired_heading: 1.5,
            ..params
        });
        assert!(matches!(
            manager.directive(),
            Some(MoveToDirective::TurnToHeading { params })
                if (params.desired_heading - 1.5).abs() < 1e-6
        ));

        let before = manager.clone();
        manager.use_time();
        assert_eq!(manager, before, "no driver in D3 — use_time is inert");

        manager.cancel_moveto(0x36);
        assert_eq!(manager.directive(), None);
        assert_eq!(manager.last_cancel_error(), Some(0x36));
    }

    /// `hit_ground` records the owed re-begin only while a directive is
    /// active; `handle_update_target` records the A2-P3 anchor.
    #[test]
    fn hit_ground_and_target_update_bookkeeping() {
        let mut manager = MoveToManager::default();
        manager.hit_ground();
        assert!(!manager.pending_hit_ground_rebegin(), "no directive, no re-begin owed");

        manager.move_to_position(origin(), MovementParameters::default());
        manager.hit_ground();
        assert!(manager.pending_hit_ground_rebegin());

        let target = Guid::from(0x8000_0002_u32);
        manager.handle_update_target(target, origin());
        assert_eq!(manager.last_target_update().map(|(g, _)| *g), Some(target));

        manager.cancel_moveto(0x36);
        assert!(!manager.pending_hit_ground_rebegin(), "cancel clears the owed re-begin");
    }
}
