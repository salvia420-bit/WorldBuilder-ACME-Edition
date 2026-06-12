//! A14-I4 (W3+ S11, 2026-06-12) — the retail jump charge clock,
//! relocated from JS (`index.html` `__jumpKeydownTs` hold-math) into the
//! movement crate so ONE runtime owns the retail `ClientCombatSystem`
//! charge state (`jump_pending` / `buildInProgress` / `buildStartTime`,
//! acclient.c:407902-407916, :408033-408078). The UI only READS the
//! clock (retail `ClientUISystem::OnAction` → `GetJumpPowerLevel`,
//! acclient.c:402173) via the wasm `jumpChargeLevel()` shadow getter.
//!
//! Reached only under the JS-parsed `?jumpParity=on` flag (default-off;
//! the legacy `SessionCommand::Jump { power }` arm + JS clock remain the
//! default path, byte-identical).

use holtburger_world::WorldState;
use web_time::Instant;

/// Retail `MIN_JUMP_EXTENT` — the floor `GetJumpPowerLevel` applies
/// while a charge is pending (acclient.c:408081-408104; constant at
/// acclient.c:41626).
pub(super) const MIN_JUMP_EXTENT: f32 = 0.001;

/// Retail `GetPowerBarLevel` divisor: 1.0 s normally, 0.8 s when the
/// local player's interpreted `current_style == 0x80000046`
/// (acclient.c:407933-407949). Our protocol enum names raw `0x0046`
/// `MotionStance::DualWieldCombat` (spec §6 Q2: the CONSTANT is
/// dual-cited; the enum NAME is inherited from ACE and unverified, so
/// the comparison below is against the raw constant).
const FAST_CHARGE_STYLE_RAW: u16 = 0x0046;
const FAST_CHARGE_DIVISOR_SECS: f32 = 0.8;
const DEFAULT_CHARGE_DIVISOR_SECS: f32 = 1.0;

/// Retail jump refusal codes — the `jump_is_allowed` /
/// `jump_charge_is_allowed` error set (acclient.c:343922-343974,
/// :343845-343879), surfaced to JS as scroll text (retail
/// `ClientSystem::AddTextToScroll(…, 0x1A, …)`, acclient.c:408050-408059
/// press-time, :408193-408203 release-time).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum JumpRefusal {
    /// Retail 36 — in-air release (`jump_is_allowed`,
    /// acclient.c:343944).
    InAir = 36,
    /// Retail 71 — `IsFullyConstrained` (acclient.c:343949) or the
    /// weenie stamina vfptr[16] gate (acclient.c:343965). Carried by
    /// the A4-Q1 queue-head `jump_error_code` lane only; we have no
    /// local producer yet.
    Constrained = 71,
    /// Retail 72 — blocked forward command (Fallen / crouch-sit-sleep
    /// band, `jump_charge_is_allowed` acclient.c:343856-343862).
    Position = 72,
    /// Retail 73 — the charge-time weenie vfptr[15] gate
    /// (acclient.c:343855, scroll text `cant_jump_load`). NEVER
    /// produced here: DESIGN.md:460-462 rules "no speculative
    /// charge-time gate" (spec §6 Q1); kept so the A4-Q1 queue-head
    /// lane can carry it.
    Load = 73,
}

impl JumpRefusal {
    /// Map a queue-head `jump_error_code` (A4-Q1
    /// `MotionInterp::pending_jump_error`) back into the enum.
    /// Unknown non-zero codes degrade to `Position` (the generic
    /// "can't jump from this position" class).
    pub(super) fn from_code(code: u32) -> Self {
        match code {
            36 => JumpRefusal::InAir,
            71 => JumpRefusal::Constrained,
            73 => JumpRefusal::Load,
            _ => JumpRefusal::Position,
        }
    }
}

/// Outcome of [`super::MovementSystemHandle::execute_jump_release`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum JumpOutcome {
    /// Release with no pending charge — retail `DoJump`'s
    /// `jump_pending` early-out (acclient.c:408164).
    NotCharging,
    /// Release-time validation refused; charge state already cleared
    /// (retail clears via `FinishJump` BEFORE validating,
    /// acclient.c:408168-408179).
    Refused(JumpRefusal),
    /// The jump fired: `GameAction::Jump` was built via
    /// `common::build_jump` and sent through `Session::send_action`.
    /// `jump_skill` / `burden` ride along for the wasm console-log
    /// shape (`[jump] skill=… burden=… → vz=…`).
    Jumped {
        extent: f32,
        vz: f32,
        jump_skill: u32,
        burden: f32,
    },
}

/// The retail charge clock — `ClientCombatSystem` fields
/// `jump_pending` (acclient.c:408041, :408071) + `buildInProgress` /
/// `buildStartTime` (`StartPowerBarBuild`, acclient.c:407902-407916),
/// fused (`build_start.is_some()` ⇔ `buildInProgress` since the two
/// always flip together in retail's jump path).
pub(super) struct JumpChargeClock {
    /// Retail `ClientCombatSystem::jump_pending`.
    jump_pending: bool,
    /// Retail `buildStartTime` (`Some` ⇔ `buildInProgress`).
    build_start: Option<Instant>,
}

impl JumpChargeClock {
    pub(super) fn new() -> Self {
        Self {
            jump_pending: false,
            build_start: None,
        }
    }

    /// Retail `ClientCombatSystem::CommenceJump`
    /// (acclient.c:408033-408078) + `CMotionInterp::charge_jump`
    /// (acclient.c:343845-343879). `manual_axes_idle` is the
    /// movement-system view of "no forward/sidestep/turn axes held"
    /// (retail: `forward_command == 0x41000003 Ready && no sidestep &&
    /// no turn`, acclient.c:343864-343870), computed by
    /// `MovementSystem::jump_charge_commence` from the active manual
    /// drive — NOT from JS.
    pub(super) fn commence(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        manual_axes_idle: bool,
    ) -> Result<(), JumpRefusal> {
        // Double-press no-op: clock NOT restarted
        // (acclient.c:408039-408041).
        if self.jump_pending {
            return Ok(());
        }
        // Position gate (acclient.c:343856-343862). NOTE: retail reads
        // the INTERPRETED forward command; ours reads the server-echoed
        // `current_substate` (mutations.rs:305-318) — the same
        // approximation the shipped release gate makes (spec §6 Q5:
        // upgrade point = this predicate input, when A3-D1 Stage-2's
        // interpreted state goes live).
        //
        // NO charge-time error-73 gate — DESIGN.md:460-462 (spec §6 Q1).
        if !holtburger_world::player::motion_allows_jump(world.player.current_substate) {
            return Err(JumpRefusal::Position);
        }
        // Success side effects (acclient.c:408062-408075 +
        // StartPowerBarBuild :407902-407916). Auto-repeat-attack cancel
        // and BeginPowerbar notice have no analog here (no auto-attack
        // loop; the UI polls the level getter instead of a notice).
        self.jump_pending = true;
        self.build_start = Some(now);
        // Standstill long-jump root (`standing_longjump`,
        // acclient.c:343864-343870): grounded (our contact+walkable
        // analog — the same `!is_airborne` check the shipped legacy
        // JumpChargeBegin arm makes) AND no held manual axes.
        if !world.player.is_airborne && manual_axes_idle {
            world.player.standing_long_jump_charge = true;
        }
        Ok(())
    }

    /// Retail `ClientCombatSystem::GetPowerBarLevel`
    /// (acclient.c:407919-407955): `(cur_time − buildStartTime) /
    /// divisor` clamped to `[0, 1]`; divisor = 0.8 iff the local
    /// player's interpreted style is raw `0x0046`
    /// (`current_style == 0x80000046`, divisor branch
    /// acclient.c:407933-407939; clamp :407940-407949). `0.0` when no
    /// build is in progress.
    pub(super) fn level(&self, now: Instant, world: &WorldState) -> f32 {
        let Some(start) = self.build_start else {
            return 0.0;
        };
        if !self.jump_pending {
            return 0.0;
        }
        let divisor = if world
            .player
            .last_server_motion_style
            .map(|stance| stance.interpreted())
            == Some(FAST_CHARGE_STYLE_RAW)
        {
            FAST_CHARGE_DIVISOR_SECS
        } else {
            DEFAULT_CHARGE_DIVISOR_SECS
        };
        (now.saturating_duration_since(start).as_secs_f32() / divisor).clamp(0.0, 1.0)
    }

    /// Retail `ClientCombatSystem::GetJumpPowerLevel`
    /// (acclient.c:408081-408104): `jump_pending ?
    /// max(GetPowerBarLevel, MIN_JUMP_EXTENT) : 0.0`. This is what the
    /// UI reads (acclient.c:402173) and what release uses as the
    /// extent (acclient.c:408168-408173).
    pub(super) fn power(&self, now: Instant, world: &WorldState) -> f32 {
        if self.jump_pending {
            self.level(now, world).max(MIN_JUMP_EXTENT)
        } else {
            0.0
        }
    }

    /// Retail `ClientCombatSystem::FinishJump`
    /// (acclient.c:407625-407648) — clears the pending flag, the bar
    /// build, AND the minterp `standing_longjump` root.
    pub(super) fn finish(&mut self, world: &mut WorldState) {
        self.jump_pending = false;
        self.build_start = None;
        world.player.standing_long_jump_charge = false;
    }

    /// Retail `ClientCombatSystem::DoJump` autonomous-branch front half
    /// (acclient.c:408146-408227): `None` when no charge is pending
    /// (:408164); otherwise read the extent (:408168-408173) and clear
    /// the charge state via [`Self::finish`] BEFORE returning — retail
    /// calls `FinishJump` (:408174) BEFORE `CMotionInterp::jump`
    /// validates (:408179), so a refused release still drops the
    /// charge + root.
    pub(super) fn release(&mut self, now: Instant, world: &mut WorldState) -> Option<f32> {
        if !self.jump_pending {
            return None;
        }
        let extent = self.power(now, world);
        self.finish(world);
        Some(extent)
    }

    /// Test/diagnostic visibility of the pending flag.
    #[cfg(test)]
    pub(super) fn is_pending(&self) -> bool {
        self.jump_pending
    }

    /// Test visibility of the build-start stamp (double-press test).
    #[cfg(test)]
    pub(super) fn build_start(&self) -> Option<Instant> {
        self.build_start
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Guid, Quaternion, Vector3};
    use std::time::Duration;

    fn test_world() -> WorldState {
        let mut world = WorldState::synthetic();
        world.seed_local_player_entity(
            Guid(0x5000_0123),
            "Player",
            WorldPosition {
                landblock_id: Guid(0x1234_0000),
                coords: Vector3::new(10.0, 20.0, 0.0),
                rotation: Quaternion::from_heading(0.0),
            },
        );
        world
    }

    // Spec test 1 — clock curve (acclient.c:407940-407949).
    #[test]
    fn level_follows_one_second_curve_with_clamp() {
        let mut world = test_world();
        let mut clock = JumpChargeClock::new();
        let t0 = Instant::now();
        assert_eq!(clock.level(t0, &world), 0.0, "pre-commence level must be 0");
        clock.commence(t0, &mut world, true).expect("commence");
        assert!((clock.level(t0 + Duration::from_millis(500), &world) - 0.5).abs() < 1e-3);
        assert!((clock.level(t0 + Duration::from_secs(1), &world) - 1.0).abs() < 1e-6);
        assert_eq!(clock.level(t0 + Duration::from_secs(2), &world), 1.0);
    }

    // Spec test 2 — 0.8 s divisor for raw style 0x0046
    // (acclient.c:407933-407939).
    #[test]
    fn fast_charge_style_uses_point_eight_divisor() {
        let mut world = test_world();
        world.player.update_last_server_motion_style(0x0046);
        let mut clock = JumpChargeClock::new();
        let t0 = Instant::now();
        clock.commence(t0, &mut world, true).expect("commence");
        assert_eq!(clock.level(t0 + Duration::from_millis(800), &world), 1.0);
        assert!((clock.level(t0 + Duration::from_millis(400), &world) - 0.5).abs() < 1e-3);
    }

    // Spec test 3 — instant release floors at MIN_JUMP_EXTENT
    // (acclient.c:408081-408104, :408169-408173).
    #[test]
    fn instant_release_floors_extent() {
        let mut world = test_world();
        let mut clock = JumpChargeClock::new();
        let t0 = Instant::now();
        clock.commence(t0, &mut world, true).expect("commence");
        let extent = clock.release(t0, &mut world).expect("charging");
        assert_eq!(extent, MIN_JUMP_EXTENT);
    }

    // Spec test 4 — double-press no-op, clock NOT restarted
    // (acclient.c:408039-408041).
    #[test]
    fn double_press_does_not_restart_clock() {
        let mut world = test_world();
        let mut clock = JumpChargeClock::new();
        let t0 = Instant::now();
        clock.commence(t0, &mut world, true).expect("commence");
        let stamp = clock.build_start().expect("build started");
        clock
            .commence(t0 + Duration::from_millis(300), &mut world, true)
            .expect("second press is Ok");
        assert_eq!(clock.build_start(), Some(stamp), "build_start unchanged");
    }

    // Spec test 5 — crouch substate refuses with Position(72)
    // (acclient.c:343856-343862; types.rs Crouch 0x41000012).
    #[test]
    fn crouch_substate_refuses_position() {
        let mut world = test_world();
        world.player.current_substate = 0x4100_0012;
        let mut clock = JumpChargeClock::new();
        let t0 = Instant::now();
        assert_eq!(
            clock.commence(t0, &mut world, true),
            Err(JumpRefusal::Position)
        );
        assert!(!clock.is_pending(), "refused press must not arm the clock");
    }

    // Spec test 6 — standstill root matrix (acclient.c:343864-343870).
    #[test]
    fn standstill_root_matrix() {
        let t0 = Instant::now();
        // grounded + no axes → root set
        let mut world = test_world();
        let mut clock = JumpChargeClock::new();
        clock.commence(t0, &mut world, true).expect("commence");
        assert!(world.player.standing_long_jump_charge);
        // held axis → not set
        let mut world = test_world();
        let mut clock = JumpChargeClock::new();
        clock.commence(t0, &mut world, false).expect("commence");
        assert!(!world.player.standing_long_jump_charge);
        // airborne → not set (clock still arms; release gate refuses
        // later, retail's in-air ordering)
        let mut world = test_world();
        world.player.is_airborne = true;
        let mut clock = JumpChargeClock::new();
        clock.commence(t0, &mut world, true).expect("commence");
        assert!(!world.player.standing_long_jump_charge);
    }

    // Spec test 7 — release after abort → None (acclient.c:408164).
    #[test]
    fn release_after_abort_is_not_charging() {
        let mut world = test_world();
        let mut clock = JumpChargeClock::new();
        let t0 = Instant::now();
        clock.commence(t0, &mut world, true).expect("commence");
        clock.finish(&mut world);
        assert_eq!(clock.release(t0 + Duration::from_secs(1), &mut world), None);
    }

    // Spec test 8 (clock half) — release clears pending + root BEFORE
    // the caller validates (acclient.c:408168-408179 ordering). The
    // gate half lives in system/tests.rs
    // (`refused_release_still_clears_charge`).
    #[test]
    fn release_clears_pending_and_root() {
        let mut world = test_world();
        let mut clock = JumpChargeClock::new();
        let t0 = Instant::now();
        clock.commence(t0, &mut world, true).expect("commence");
        assert!(world.player.standing_long_jump_charge);
        let extent = clock
            .release(t0 + Duration::from_millis(700), &mut world)
            .expect("charging");
        assert!((extent - 0.7).abs() < 1e-3);
        assert!(!clock.is_pending());
        assert!(!world.player.standing_long_jump_charge);
        assert_eq!(clock.power(t0 + Duration::from_secs(1), &world), 0.0);
    }
}
