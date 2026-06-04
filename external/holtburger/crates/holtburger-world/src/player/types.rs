use crate::stats;
use holtburger_common::{CharacterOption, CharacterOptions1, CharacterOptions2, Guid, Vector3};
use holtburger_protocol::messages::EquipMask;
use holtburger_protocol::messages::magic::Enchantment;
use holtburger_protocol::messages::movement::{MotionStance, PositionType};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Wave 10 Phase 10.2 (2026-05-26) — full 32-bit
/// [`MotionCommand`](https://github.com/ACEmulator/ACE/blob/master/Source/ACE.Entity/Enum/MotionCommand.cs)
/// constants used by [`PlayerState::current_substate`] and
/// [`motion_allows_jump`].
///
/// Only the substates the jump gate cares about are listed here. The
/// full 409-entry table lives in
/// `crates/holtburger-dat/tests/common/motion_command_names.rs` (test
/// scaffolding) and `apps/holtburger-web/data/motion-command-names.json`
/// (runtime renderer).
#[allow(dead_code, non_snake_case)]
pub mod MotionCommandCode {
    /// `Ready` — at-rest pose, the universal "you can jump from here"
    /// substate. Default for [`PlayerState::current_substate`].
    pub const READY: u32 = 0x4100_0003;
    /// `Fallen` — post-fall stagger pose. Blocked by
    /// [`motion_allows_jump`] (PhatSDK `MovementManager.cpp:434`).
    /// **NOT** the same as `Falling`: Falling is the in-air looping
    /// cycle, gated by `PlayerState::is_airborne`.
    pub const FALLEN: u32 = 0x4000_0008;
    /// `Falling` — in-air looping cycle. NOT in the PhatSDK blocked
    /// set; double-jump prevention runs through `is_airborne`.
    pub const FALLING: u32 = 0x4000_0015;
    /// `Jump` — set on [`PlayerState::begin_jump`]. Not in PhatSDK's
    /// blocked set (`is_airborne` gates instead).
    pub const JUMP: u32 = 0x2500_003B;
}

/// Wave 10 Phase 10.2 (2026-05-26) — port of PhatSDK
/// `CMotionInterp::motion_allows_jump` at
/// `external/GDL/PhatSDK/MovementManager.cpp:427-438`. Returns `true`
/// when the substate is one the retail client would permit jumping
/// from, `false` when retail would emit "You can't jump from this
/// position." (`WeenieError::YouCantJumpFromThisPosition = 0x0048`).
///
/// The ranges mirror PhatSDK exactly:
///
/// - `0x40000016..=0x40000018` — `Reload`, `Unload`, `Pickup`
///   (interactions in progress)
/// - `0x10000128..=0x10000131` — `TripleThrustLow..MagicPowerUp07Purple`
///   (multi-strike attack windups + colored magic powerups)
/// - `0x1000006F..=0x10000078` — `MagicPowerUp01..MagicPowerUp10`
///   (war-magic cast windups)
/// - `0x41000012..=0x41000014` — `Crouch`, `Sitting`, `Sleeping`
///   (stationary held poses)
/// - `0x4000001E..=0x40000039` — `AimLevel..MagicPray`
///   (aim states + magic spell substates)
/// - `0x40000008` — `Fallen` (post-fall stagger)
///
/// Note: `Falling (0x40000015)` is NOT in this set per retail — the
/// PhatSDK source does not block on it. Double-jump prevention runs
/// via the `is_airborne` flag (the recv-loop `Jump` arm at
/// `apps/holtburger-web/src/lib.rs` short-circuits when
/// `world.player.is_airborne`).
#[inline]
pub fn motion_allows_jump(substate: u32) -> bool {
    !(matches!(substate, 0x4000_0016..=0x4000_0018)
        || matches!(substate, 0x1000_0128..=0x1000_0131)
        || matches!(substate, 0x1000_006F..=0x1000_0078)
        || matches!(substate, 0x4100_0012..=0x4100_0014)
        || matches!(substate, 0x4000_001E..=0x4000_0039)
        || substate == 0x4000_0008)
}

/// Wave 10 Phase 10.2 (2026-05-26) — expand a low-16
/// `InterpretedMotionCommand` to its full 32-bit `MotionCommand`
/// value. ACE / the wire format only carries the low-16 substate
/// (see `external/holtburger/crates/holtburger-protocol/src/messages/
/// movement/types.rs:230` — `InterpretedMotionState::forward_command:
/// Option<InterpretedMotionCommand>` where `InterpretedMotionCommand`
/// is a `pub u16` newtype), but PhatSDK's
/// [`motion_allows_jump`] operates on the full 32-bit value.
///
/// This is a partial table that ONLY covers the substates needed for
/// jump-gating (the ranges enumerated in [`motion_allows_jump`] plus a
/// few well-known idle states). Misses return `None`; the caller
/// should preserve the previous substate when this happens (a
/// permissive default keeps jump from breaking on unknown server
/// motion commands).
///
/// Sourced from ACE `Source/ACE.Entity/Enum/MotionCommand.cs` (lines
/// 7-127 + the substate ranges starting at 304).
pub fn expand_motion_command_low16(low16: u16) -> Option<u32> {
    match low16 {
        // Idle / locomotion (not in blocked set, but tracked so the
        // substate field stays correctly populated when the player
        // walks/runs around).
        0x0003 => Some(0x4100_0003), // Ready
        0x0004 => Some(0x4000_0004), // Stop
        0x0005 => Some(0x4500_0005), // WalkForward
        0x0006 => Some(0x4500_0006), // WalkBackwards
        0x0007 => Some(0x4400_0007), // RunForward
        // Fallen — blocked (post-fall stagger).
        0x0008 => Some(0x4000_0008), // Fallen
        // Falling — NOT blocked here; is_airborne covers it.
        0x0015 => Some(0x4000_0015), // Falling
        // Reload..Pickup — blocked.
        0x0016 => Some(0x4000_0016), // Reload
        0x0017 => Some(0x4000_0017), // Unload
        0x0018 => Some(0x4000_0018), // Pickup
        // Crouch..Sleeping — blocked.
        0x0012 => Some(0x4100_0012), // Crouch
        0x0013 => Some(0x4100_0013), // Sitting
        0x0014 => Some(0x4100_0014), // Sleeping
        // AimLevel..MagicPray — blocked.
        0x001E..=0x0039 => Some(0x4000_0000 | u32::from(low16)),
        // MagicPowerUp01..MagicPowerUp10 — blocked.
        0x006F..=0x0078 => Some(0x1000_0000 | u32::from(low16)),
        // TripleThrustLow..MagicPowerUp07Purple — blocked.
        0x0128..=0x0131 => Some(0x1000_0000 | u32::from(low16)),
        // Jump — set explicitly by begin_jump; not normally
        // round-tripped via UpdateMotion.
        0x003B => Some(0x2500_003B), // Jump
        _ => None,
    }
}

#[cfg(test)]
mod motion_allows_jump_tests {
    use super::*;

    /// PhatSDK `MovementManager.cpp:434` — Fallen is the lone single
    /// value in the blocked set.
    #[test]
    fn fallen_is_blocked() {
        assert!(!motion_allows_jump(0x4000_0008), "Fallen must block jump");
    }

    /// PhatSDK `MovementManager.cpp:429` — `0x40000016..0x40000018` =
    /// Reload, Unload, Pickup.
    #[test]
    fn reload_unload_pickup_blocked() {
        assert!(!motion_allows_jump(0x4000_0016), "Reload must block");
        assert!(!motion_allows_jump(0x4000_0017), "Unload must block");
        assert!(!motion_allows_jump(0x4000_0018), "Pickup must block");
    }

    /// PhatSDK `MovementManager.cpp:432` — `0x41000012..0x41000014` =
    /// Crouch, Sitting, Sleeping.
    #[test]
    fn crouch_sitting_sleeping_blocked() {
        assert!(!motion_allows_jump(0x4100_0012), "Crouch must block");
        assert!(!motion_allows_jump(0x4100_0013), "Sitting must block");
        assert!(!motion_allows_jump(0x4100_0014), "Sleeping must block");
    }

    /// PhatSDK `MovementManager.cpp:433` — `0x4000001E..0x40000039` =
    /// AimLevel through MagicPray (spell windups).
    #[test]
    fn aim_states_and_magic_substates_blocked() {
        assert!(!motion_allows_jump(0x4000_001E), "AimLevel must block");
        assert!(!motion_allows_jump(0x4000_002B), "MagicBlast must block");
        assert!(!motion_allows_jump(0x4000_0031), "MagicHeal must block");
        assert!(!motion_allows_jump(0x4000_0039), "MagicPray must block");
    }

    /// PhatSDK `MovementManager.cpp:431` — `0x1000006F..0x10000078` =
    /// MagicPowerUp01..MagicPowerUp10 (cast windups).
    #[test]
    fn magic_powerup_windups_blocked() {
        assert!(
            !motion_allows_jump(0x1000_006F),
            "MagicPowerUp01 must block"
        );
        assert!(
            !motion_allows_jump(0x1000_0074),
            "MagicPowerUp06 must block"
        );
        assert!(
            !motion_allows_jump(0x1000_0078),
            "MagicPowerUp10 must block"
        );
    }

    /// PhatSDK `MovementManager.cpp:430` — `0x10000128..0x10000131` =
    /// TripleThrustLow..MagicPowerUp07Purple.
    #[test]
    fn triple_thrust_and_purple_powerups_blocked() {
        assert!(
            !motion_allows_jump(0x1000_0128),
            "TripleThrustLow must block"
        );
        assert!(
            !motion_allows_jump(0x1000_012B),
            "MagicPowerUp01Purple must block"
        );
        assert!(
            !motion_allows_jump(0x1000_0131),
            "MagicPowerUp07Purple must block"
        );
    }

    /// Allowed substates outside the PhatSDK ranges.
    #[test]
    fn ready_and_walk_allow_jump() {
        assert!(motion_allows_jump(0x4100_0003), "Ready must allow jump");
        assert!(
            motion_allows_jump(0x4500_0005),
            "WalkForward must allow jump"
        );
        assert!(
            motion_allows_jump(0x4400_0007),
            "RunForward must allow jump"
        );
    }

    /// Falling (0x40000015) is NOT in the PhatSDK blocked set — the
    /// `is_airborne` flag gates double-jumps separately.
    #[test]
    fn falling_substate_alone_does_not_block() {
        assert!(
            motion_allows_jump(0x4000_0015),
            "Falling itself is not blocked by motion_allows_jump"
        );
    }

    /// Boundary values around the blocked ranges — verify the ranges
    /// are inclusive on the low end, exclusive past the high end.
    #[test]
    fn range_boundaries_match_phatsdk() {
        // Just below Reload range
        assert!(
            motion_allows_jump(0x4000_0015),
            "Falling sits below the Reload range and is allowed"
        );
        // Just past Pickup
        assert!(
            motion_allows_jump(0x4000_0019),
            "0x40000019 = StoreInBackpack is allowed"
        );
        // Just below MagicPowerUp01
        assert!(motion_allows_jump(0x1000_006E), "SpinAttack is allowed");
        // Just past MagicPowerUp10
        assert!(motion_allows_jump(0x1300_0079), "ShakeFist is allowed");
        // Just past MagicPray
        assert!(motion_allows_jump(0x2000_003A), "StopTurning is allowed");
        // Just past TripleThrust range
        assert!(
            motion_allows_jump(0x1000_0132),
            "MagicPowerUp08Purple is allowed"
        );
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct SkillBase {
    pub ranks: u32,
    pub init: u32,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct VitalBase {
    pub ranks: u32,
    pub start: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct LastSentStats {
    pub attributes: Vec<stats::Attribute>,
    pub vitals: Vec<stats::Vital>,
    pub skills: Vec<stats::Skill>,
    pub resistances: stats::Resistances,
    pub armor: i32,
    pub vitae: f32,
}

enum CharacterOptionMask {
    Options1(CharacterOptions1),
    Options2(CharacterOptions2),
}

fn character_option_mask(option: CharacterOption) -> CharacterOptionMask {
    match option {
        CharacterOption::AutoRepeatAttacks => {
            CharacterOptionMask::Options1(CharacterOptions1::AUTO_REPEAT_ATTACK)
        }
        CharacterOption::IgnoreAllegianceRequests => {
            CharacterOptionMask::Options1(CharacterOptions1::IGNORE_ALLEGIANCE_REQUESTS)
        }
        CharacterOption::IgnoreFellowshipRequests => {
            CharacterOptionMask::Options1(CharacterOptions1::IGNORE_FELLOWSHIP_REQUESTS)
        }
        CharacterOption::IgnoreAllTradeRequests => {
            CharacterOptionMask::Options1(CharacterOptions1::IGNORE_TRADE_REQUESTS)
        }
        CharacterOption::DisableMostWeatherEffects => {
            CharacterOptionMask::Options1(CharacterOptions1::DISABLE_MOST_WEATHER_EFFECTS)
        }
        CharacterOption::AlwaysDaylightOutdoors => {
            CharacterOptionMask::Options2(CharacterOptions2::PERSISTENT_AT_DAY)
        }
        CharacterOption::LetOtherPlayersGiveYouItems => {
            CharacterOptionMask::Options1(CharacterOptions1::ALLOW_GIVE)
        }
        CharacterOption::KeepCombatTargetsInView => {
            CharacterOptionMask::Options1(CharacterOptions1::VIEW_COMBAT_TARGET)
        }
        CharacterOption::Display3dTooltips => {
            CharacterOptionMask::Options1(CharacterOptions1::SHOW_TOOLTIPS)
        }
        CharacterOption::AttemptToDeceiveOtherPlayers => {
            CharacterOptionMask::Options1(CharacterOptions1::USE_DECEPTION)
        }
        CharacterOption::RunAsDefaultMovement => {
            CharacterOptionMask::Options1(CharacterOptions1::TOGGLE_RUN)
        }
        CharacterOption::StayInChatModeAfterSendingMessage => {
            CharacterOptionMask::Options1(CharacterOptions1::STAY_IN_CHAT_MODE)
        }
        CharacterOption::AdvancedCombatInterface => {
            CharacterOptionMask::Options1(CharacterOptions1::ADVANCED_COMBAT_UI)
        }
        CharacterOption::AutoTarget => {
            CharacterOptionMask::Options1(CharacterOptions1::AUTO_TARGET)
        }
        CharacterOption::VividTargetingIndicator => {
            CharacterOptionMask::Options1(CharacterOptions1::VIVID_TARGETING_INDICATOR)
        }
        CharacterOption::ShareFellowshipExpAndLuminance => {
            CharacterOptionMask::Options1(CharacterOptions1::FELLOWSHIP_SHARE_XP)
        }
        CharacterOption::AcceptCorpseLootingPermissions => {
            CharacterOptionMask::Options1(CharacterOptions1::ACCEPT_LOOT_PERMITS)
        }
        CharacterOption::ShareFellowshipLoot => {
            CharacterOptionMask::Options1(CharacterOptions1::FELLOWSHIP_SHARE_LOOT)
        }
        CharacterOption::AutomaticallyAcceptFellowshipRequests => {
            CharacterOptionMask::Options1(CharacterOptions1::AUTO_ACCEPT_FELLOW_REQUEST)
        }
        CharacterOption::SideBySideVitals => {
            CharacterOptionMask::Options1(CharacterOptions1::SIDE_BY_SIDE_VITALS)
        }
        CharacterOption::ShowCoordinatesByTheRadar => {
            CharacterOptionMask::Options1(CharacterOptions1::COORDINATES_ON_RADAR)
        }
        CharacterOption::DisplaySpellDurations => {
            CharacterOptionMask::Options1(CharacterOptions1::SPELL_DURATION)
        }
        CharacterOption::DisableHouseRestrictionEffects => {
            CharacterOptionMask::Options1(CharacterOptions1::DISABLE_HOUSE_RESTRICTION_EFFECTS)
        }
        CharacterOption::DragItemToPlayerOpensTrade => {
            CharacterOptionMask::Options1(CharacterOptions1::DRAG_ITEM_ON_PLAYER_OPENS_SECURE_TRADE)
        }
        CharacterOption::ShowAllegianceLogons => {
            CharacterOptionMask::Options1(CharacterOptions1::DISPLAY_ALLEGIANCE_LOGON_NOTIFICATIONS)
        }
        CharacterOption::UseChargeAttack => {
            CharacterOptionMask::Options1(CharacterOptions1::USE_CHARGE_ATTACK)
        }
        CharacterOption::UseCraftingChanceOfSuccessDialog => {
            CharacterOptionMask::Options1(CharacterOptions1::USE_CRAFT_SUCCESS_DIALOG)
        }
        CharacterOption::ListenToAllegianceChat => {
            CharacterOptionMask::Options1(CharacterOptions1::HEAR_ALLEGIANCE_CHAT)
        }
        CharacterOption::AllowOthersToSeeYourDateOfBirth => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_DATE_OF_BIRTH)
        }
        CharacterOption::AllowOthersToSeeYourAge => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_AGE)
        }
        CharacterOption::AllowOthersToSeeYourChessRank => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_CHESS_RANK)
        }
        CharacterOption::AllowOthersToSeeYourFishingSkill => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_FISHING_SKILL)
        }
        CharacterOption::AllowOthersToSeeYourNumberOfDeaths => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_NUMBER_DEATHS)
        }
        CharacterOption::DisplayTimestamps => {
            CharacterOptionMask::Options2(CharacterOptions2::TIME_STAMP)
        }
        CharacterOption::SalvageMultipleMaterialsAtOnce => {
            CharacterOptionMask::Options2(CharacterOptions2::SALVAGE_MULTIPLE)
        }
        CharacterOption::ListenToGeneralChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_GENERAL_CHAT)
        }
        CharacterOption::ListenToTradeChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_TRADE_CHAT)
        }
        CharacterOption::ListenToLFGChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_LFG_CHAT)
        }
        CharacterOption::ListenToRoleplayChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_ROLEPLAY_CHAT)
        }
        CharacterOption::AppearOffline => {
            CharacterOptionMask::Options2(CharacterOptions2::APPEAR_OFFLINE)
        }
        CharacterOption::AllowOthersToSeeYourNumberOfTitles => {
            CharacterOptionMask::Options2(CharacterOptions2::DISPLAY_NUMBER_CHARACTER_TITLES)
        }
        CharacterOption::UseMainPackAsDefaultForPickingUpItems => {
            CharacterOptionMask::Options2(CharacterOptions2::MAIN_PACK_PREFERRED)
        }
        CharacterOption::LeadMissileTargets => {
            CharacterOptionMask::Options2(CharacterOptions2::LEAD_MISSILE_TARGETS)
        }
        CharacterOption::UseFastMissiles => {
            CharacterOptionMask::Options2(CharacterOptions2::USE_FAST_MISSILES)
        }
        CharacterOption::FilterLanguage => {
            CharacterOptionMask::Options2(CharacterOptions2::FILTER_LANGUAGE)
        }
        CharacterOption::ConfirmUseOfRareGems => {
            CharacterOptionMask::Options2(CharacterOptions2::CONFIRM_VOLATILE_RARE_USE)
        }
        CharacterOption::ListenToSocietyChat => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_SOCIETY_CHAT)
        }
        CharacterOption::ShowYourHelmOrHeadGear => {
            CharacterOptionMask::Options2(CharacterOptions2::SHOW_HELM)
        }
        CharacterOption::DisableDistanceFog => {
            CharacterOptionMask::Options2(CharacterOptions2::DISABLE_DISTANCE_FOG)
        }
        CharacterOption::UseMouseTurning => {
            CharacterOptionMask::Options2(CharacterOptions2::USE_MOUSE_TURNING)
        }
        CharacterOption::ShowYourCloak => {
            CharacterOptionMask::Options2(CharacterOptions2::SHOW_CLOAK)
        }
        CharacterOption::LockUI => CharacterOptionMask::Options2(CharacterOptions2::LOCK_UI),
        CharacterOption::ListenToPKDeathMessages => {
            CharacterOptionMask::Options2(CharacterOptions2::HEAR_PK_DEATH)
        }
        CharacterOption::CharacterOptions1Default => {
            CharacterOptionMask::Options1(CharacterOptions1::DEFAULT)
        }
        CharacterOption::CharacterOptions2Default => {
            CharacterOptionMask::Options2(CharacterOptions2::DEFAULT)
        }
    }
}

/// Session-local player model and derived player-facing state.
///
/// `PlayerState` owns player-specific data such as attributes, vitals, spells, inventory, and
/// protocol sequence tracking. It is intentionally **not** a second world object: authoritative
/// entity/object state lives on the player `Entity`, while `PlayerState` retains only local-player
/// overlays and session sequencing. Feature handlers under `crate::handlers` orchestrate message
/// flows and call into focused mutation methods on `PlayerState` and `WorldState`.
///
#[derive(Debug, Clone)]
pub struct PlayerState {
    /// Unique identifier for the player's character.
    pub guid: Guid,
    /// Computed attribute values (Strength, Endurance, etc.) including buffs.
    pub attributes: HashMap<stats::AttributeType, stats::Attribute>,
    /// Computed vital values (Health, Stamina, Mana) including current/max/buffed states.
    pub vitals: HashMap<stats::VitalType, stats::Vital>,
    /// Stores the raw ranks and start for vitals so they can be recalculated during stat updates.
    pub vital_bases: HashMap<stats::VitalType, VitalBase>,
    /// Computed skill values (Melee Defense, War Magic, etc.) including training level and buffs.
    pub skills: HashMap<stats::SkillType, stats::Skill>,
    /// Stores the raw ranks and init for skills so they can be recalculated during stat updates.
    pub skill_bases: HashMap<stats::SkillType, SkillBase>,
    /// Sequence for object instantiation/removal.
    pub instance_sequence: u16,
    /// Sequence for server-controlled movement/actions.
    pub server_control_sequence: u16,
    /// Last non-zero server-reported motion stance/style cached for outbound movement packets.
    pub last_server_motion_style: Option<MotionStance>,
    /// Sequence for teleportation events to ignore stale position updates.
    pub teleport_sequence: u16,
    /// Sequence for server-forced repositions (e.g. rubberbanding or physics corrections).
    pub force_position_sequence: u16,
    /// Sequence for client-initiated position updates.
    pub position_sequence: u16,
    /// Sequence for authoritative VectorUpdate (velocity/omega) frames.
    ///
    /// Retail's `SmartBox::DoVectorUpdate` gates velocity/omega
    /// application on `CPhysicsObj::update_times[3]` (the `ObjectVector`
    /// stamp, acclient.c:143459-143480) — distinct from
    /// `instance_sequence`. Previously the self VectorUpdate handler
    /// misfiled the VectorUpdate's `instance_sequence` onto
    /// `instance_sequence` and never stored `vector_sequence` at all;
    /// this field is the correctly-named home for the latter. Read by
    /// the (default-off) `USE_VECTOR_SEQUENCE_GATE` newer-than gate in
    /// `state/mutations.rs::set_player_vector`.
    pub vector_sequence: u16,
    /// Last grounded bit reported by authoritative self movement updates.
    pub last_server_grounded: Option<bool>,
    /// Monotonically increasing sequence for autonomous movement steps.
    pub movement_sequence: u16,
    /// Session-local private position overlays keyed by packet `PositionType`.
    pub local_position_overlays: HashMap<PositionType, holtburger_common::position::WorldPosition>,
    /// List of all active enchantments (buffs/debuffs) currently affecting the player.
    pub enchantments: Vec<Enchantment>,
    /// Master list of known spells (Knowledge). Maps SpellID -> Power/Modifier level.
    pub spells: BTreeMap<u32, f32>,
    /// Primary character option mask retained from PlayerDescription.
    pub options1: CharacterOptions1,
    /// Secondary character option mask retained from PlayerDescription.
    pub options2: CharacterOptions2,
    /// Content of the 8 spellbook hotbars (Organization). Each inner vec corresponds to a UI hotbar.
    pub hotbar_spells: Vec<Vec<u32>>,
    /// Desired material component counts retained from PlayerDescription.
    pub desired_comps: Vec<(u32, u32)>,
    /// Spellbook filter bitfield retained from PlayerDescription.
    pub spellbook_filters: u32,
    /// Opaque gameplay options blob retained from PlayerDescription.
    pub gameplay_options: Vec<u8>,

    /// Flat set of all item GUIDs currently owned by the player (in pack or containers).
    pub inventory: HashSet<Guid>,
    /// Items currently equipped, mapped by their primary slot mask.
    pub equipment: HashMap<Guid, EquipMask>,

    /// Dirty tracking for emitted derived-stat snapshots.
    pub(crate) last_emitted_derived_stats: Option<LastSentStats>,

    /// `true` while the local-prediction integrator should integrate
    /// gravity on the player Z each tick instead of snapping to the
    /// terrain / cell floor. Set by the recv-loop `Jump` arm; cleared
    /// when the integrator detects landing (downward `vertical_velocity`
    /// + Z below floor). Mirrors ACE's airborne handling in
    /// `Player_Move.cs` (the integrator's gravity loop while no
    /// floor contact is reported).
    pub is_airborne: bool,
    /// Wave 5 Phase 5.1 (movement-animation overhaul, 2026-05-26):
    /// distinguishes a `begin_jump()`-initiated airborne phase from a
    /// "walked off a ledge" airborne phase. Set to `true` only by
    /// [`begin_jump`]; cleared by [`land`]. The recv-loop animation
    /// emission uses this flag to route the right `MotionCommand` to
    /// the renderer:
    /// - `is_airborne && is_jumping` → Jump clip (already broadcast
    ///   from JS keyup handler at `index.html:7755`)
    /// - `is_airborne && !is_jumping` → `Falling` cycle so the rig
    ///   doesn't T-pose during a ledge walk-off.
    pub is_jumping: bool,
    /// Player's local Z velocity in m/s while [`is_airborne`].
    /// Initialized to the result of [`compute_jump_velocity_z`]
    /// on `Jump` and decremented by `9.8 * dt` per tick (ACE
    /// `MovementSystem.GetJumpHeight` derives height from this same
    /// kinematic — `v = sqrt(h * 19.6)` → `g = 9.8 m/s²`). Reset to
    /// 0.0 on landing or teleport.
    pub vertical_velocity: f32,
    /// Physics deep-dive 2026-06-01 (gap 3 follow-up: edge_slide).
    /// The local player's `AllowEdgeSlide` physics flag — retail's
    /// `ObjectInfoState.EdgeSlide` (acclient `OBJECT_INFO_STATE`
    /// `EDGE_SLIDE 0x2`; ACE `PhysicsState.EdgeSlide 0x00400000`,
    /// hydrated into [`PropertyBool::AllowEdgeSlide`] at
    /// `hydration.rs:285-288`). When set, retail's
    /// `Transition.EdgeSlide` (`Physics/Transition.cs:268-320`) skids the
    /// blocked motion along the contact-plane tangent instead of stopping
    /// dead; when clear it just stops. The local-prediction edge_slide
    /// path in `crates/holtburger-core/.../movement/system.rs` consults
    /// this flag before sliding a refused step-up's residual along the
    /// wall tangent.
    ///
    /// Default: `true` — matches the retail player default (the human
    /// body Setup ships with `EdgeSlide` set), and is the safe value
    /// before any `ObjectCreate`/`SetState` for the local player has
    /// hydrated the real flag. Refreshed from the local player's physics
    /// state in the `ObjectCreate` + `SetState` handlers
    /// (`handlers/player.rs`, `state/mutations.rs`).
    pub allow_edge_slide: bool,
    /// Wave 10 Phase 10.2 (movement-animation overhaul, 2026-05-26):
    /// the player's last-known full 32-bit `MotionCommand` substate.
    /// Mirrors PhatSDK's `CMotionInterp::interpreted_state.forward_command`
    /// (`external/GDL/PhatSDK/MovementManager.cpp:724`), which is the
    /// argument to `motion_allows_jump()` for the jump-charge gate
    /// (`MovementManager.cpp:471, 589, 1019, 1041`).
    ///
    /// Updated from three sources:
    ///
    /// 1. Server `GameMessage::UpdateMotion` for the local guid —
    ///    `data.data.state.forward_command` arrives as a low-16
    ///    [`InterpretedMotionCommand`]; the wasm-side recv handler
    ///    expands it via [`expand_motion_command_low16`] to a full
    ///    32-bit `MotionCommand` and assigns here. This covers
    ///    `/sit` (Crouch/Sitting/Sleeping), pickup, reload, item
    ///    use, spell windups (AimLevel..MagicPray + MagicPowerUp*),
    ///    and other server-driven pose changes.
    ///
    /// 2. Local jump dispatch ([`begin_jump`]) — assigns
    ///    `Jump (0x2500003B)`. The Jump substate itself is NOT in
    ///    PhatSDK's blocked set, but [`is_airborne`] already gates
    ///    double-jumps separately.
    ///
    /// 3. Local touchdown (recv-loop diff `was_airborne && !is_airborne`)
    ///    — assigns `Ready (0x41000003)` via the post-tick
    ///    [`Self::land_to_ready`] helper. Mirrors PhatSDK
    ///    `apply_interpreted_movement` falling back to Ready on
    ///    no-movement (`MovementManager.cpp:776-779`).
    ///
    /// Default: `Ready (0x41000003)` — the at-rest substate after
    /// character spawn before any UpdateMotion arrives.
    pub current_substate: u32,
    /// Wave 10 Phase 10.3 (movement-animation overhaul, 2026-05-26):
    /// smoothed lateral (X/Y) velocity in world meters per second.
    /// Mirrors `CPhysicsObj::m_velocityVector` from PhatSDK
    /// (`external/GDL/PhatSDK/PhysicsObj.h:333` — `Vector m_velocityVector`)
    /// in the X/Y plane only (Z is tracked separately in
    /// [`vertical_velocity`] for jump/fall arcs).
    ///
    /// Each tick the local-prediction integrator at
    /// `crates/holtburger-core/src/client/movement/system.rs`
    /// `advance_local_pose_for_manual_drive`:
    ///
    /// 1. Computes a `target_velocity` from
    ///    [`local_velocity_for_state`] (the input-derived velocity
    ///    based on which WASD keys the player is holding + their
    ///    current heading).
    /// 2. Applies friction decay to this stored
    ///    `current_planar_velocity` via
    ///    `v *= (1 - PLAYER_GROUND_FRICTION_PER_SEC).powf(dt)`
    ///    — mirrors `CPhysicsObj::calc_friction` formula at
    ///    `external/GDL/PhatSDK/PhysicsObj.cpp:558-559`. Skipped when
    ///    [`is_airborne`] (matches `transient_state & ON_WALKABLE_TS`
    ///    gate at `PhysicsObj.cpp:523`).
    /// 3. Snaps to zero when `|v| < PLAYER_VELOCITY_SNAP_THRESHOLD`
    ///    — mirrors the `small_velocity` short-circuit at
    ///    `PhysicsObj.cpp:589-592`.
    /// 4. Moves toward `target_velocity` capped at
    ///    `PLAYER_LATERAL_ACCELERATION_CAP_M_PER_SEC_SQ * dt` per
    ///    axis. PhatSDK has no explicit accel cap (retail uses
    ///    friction-only smoothing) — this is a wasm-side game-feel
    ///    addition to make direction changes ramp smoothly through
    ///    zero on the ground. The user explicitly called out
    ///    "jumping backwards and immediately holding W" as the
    ///    smell-test scenario.
    /// 5. The resulting `current_planar_velocity` is what drives
    ///    `pose.coords` deltas — NOT the raw input target. This is
    ///    the difference between Wave 10.3 and prior waves.
    ///
    /// Default: zero (player starts stationary).
    pub current_planar_velocity: Vector3,
    /// Physics deep-dive 2026-06-01 (gap 1): leftover frame time
    /// (seconds) below `MIN_QUANTUM` carried forward to the next
    /// integration frame. Mirrors ACE's `update_object` advancing
    /// `UpdateTime` only by the *consumed* time and leaving the
    /// sub-`MinQuantum` tail in the timer
    /// (`external/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:4159-4188`):
    /// a stream of sub-`MinQuantum` rAF frames (e.g. 16 ms @ 60 Hz)
    /// accumulates here until it crosses `MIN_QUANTUM` and a slice is
    /// integrated, matching retail's 30 Hz physics gate. Without this
    /// accumulator, gating each frame on `MIN_QUANTUM` independently
    /// would drop every 60 Hz frame and freeze movement.
    ///
    /// Reset to 0.0 when a `HugeQuantum` hitch consumes the frame
    /// without integrating (mirrors ACE setting `UpdateTime =
    /// CurrentTime`). Bounded to `< MIN_QUANTUM` (≈33 ms) at all other
    /// times, so a position correction can at worst replay one
    /// sub-`MinQuantum` slice — self-correcting and negligible.
    ///
    /// Default: zero.
    pub physics_time_accumulator: f32,
    /// Physics deep-dive 2026-06-01 (cliff_slide Stage-2) — the XY wall
    /// normal of the most-recent wall the local-drive solver clamped
    /// against, carried ACROSS integration slices so the NEXT slice can
    /// treat it as `N_last` and cross it with the slice's own
    /// `N_new` (`Vector3::Cross(N_new, N_last)`, Z-zeroed) to skid the
    /// residual along the SEAM where two non-coplanar walls meet.
    ///
    /// This is the persistent carrier for retail's
    /// `CollisionInfo.LastKnownContactPlane` (ACE
    /// `Physics/Transition.cs` `CliffSlide` / `InitLastKnownContactPlane`,
    /// `acclient.c:312005`). Retail INVALIDATES that plane on a contact
    /// reset; we mirror that by setting this to `None` on touchdown
    /// ([`PlayerState::land`]) and on any server-driven reposition
    /// (teleport / force-position resync / autonomous sync, via
    /// `WorldState::update_player_position`) — after a discontinuous
    /// pose change the previously-tracked wall is meaningless and a
    /// stale cross-product would skid along a phantom seam.
    ///
    /// Consumed only when the [`crate::spatial::cliff_slide_residual_along_seam`]
    /// Stage-2 path is enabled behind the `USE_CLIFF_SLIDE` flag; when
    /// that flag is off this field is still maintained but never read,
    /// so the shipped solver behaviour is unchanged.
    ///
    /// Default: `None` (no wall tracked at spawn).
    pub last_known_wall_normal: Option<Vector3>,

    /// Physics deep-dive 2026-06-02 (precipice_slide re-entry) — backup
    /// pose captured BEFORE a step-down walkability check, mirroring
    /// ACE/retail `CTransition::save_check_pos` /
    /// `restore_check_pos` (`acclient.c:312499-312501`) and the
    /// `Transition.EdgeSlide → StepDown → precipice_slide` re-entry
    /// (`Transition.cs:282-319`). When the player walks off a ledge
    /// within `PLAYER_STEP_DOWN_HEIGHT`, the pre-descent pose is saved
    /// here so a step-down that lands on a non-walkable surface can be
    /// restored and re-attempted as a precipice slide.
    ///
    /// Maintained (saved-before-descend / cleared-on-resolution) ONLY
    /// when the `USE_PRECIPICE_SLIDE_REENTRY` flag in
    /// `holtburger-core`'s movement system is enabled; when that flag is
    /// off this field is never written or read, so the shipped solver
    /// behaviour is unchanged (same pattern as
    /// [`last_known_wall_normal`] under `USE_CLIFF_SLIDE`).
    ///
    /// Default: `None` (no backup pose at spawn).
    pub backup_pose_for_step_down: Option<holtburger_common::position::WorldPosition>,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self::new()
    }
}

impl PlayerState {
    pub fn new() -> Self {
        Self {
            guid: Guid::NULL,
            attributes: HashMap::new(),
            vitals: HashMap::new(),
            vital_bases: HashMap::new(),
            skills: HashMap::new(),
            skill_bases: HashMap::new(),
            instance_sequence: 0,
            server_control_sequence: 0,
            last_server_motion_style: None,
            teleport_sequence: 0,
            force_position_sequence: 0,
            position_sequence: 0,
            vector_sequence: 0,
            last_server_grounded: None,
            movement_sequence: 0,
            local_position_overlays: HashMap::new(),
            enchantments: Vec::new(),
            spells: BTreeMap::new(),
            options1: CharacterOptions1::empty(),
            options2: CharacterOptions2::empty(),
            hotbar_spells: vec![Vec::new(); 8],
            desired_comps: Vec::new(),
            spellbook_filters: 0,
            gameplay_options: Vec::new(),
            inventory: HashSet::new(),
            equipment: HashMap::new(),
            last_emitted_derived_stats: None,
            is_airborne: false,
            is_jumping: false,
            vertical_velocity: 0.0,
            // Physics deep-dive 2026-06-01 (gap 3 follow-up) — default
            // to the retail player value (EdgeSlide set) until the local
            // player's physics state hydrates the real flag.
            allow_edge_slide: true,
            // Wave 10 Phase 10.2 (2026-05-26) — default to Ready
            // (the at-rest pose) so a fresh character can jump
            // before any UpdateMotion has arrived from the server.
            current_substate: MotionCommandCode::READY,
            // Wave 10 Phase 10.3 (2026-05-26) — player spawns
            // stationary; the integrator ramps from zero.
            current_planar_velocity: Vector3::zero(),
            // Physics deep-dive 2026-06-01 (gap 1) — no carried
            // frame time at spawn.
            physics_time_accumulator: 0.0,
            // Physics deep-dive 2026-06-01 (cliff_slide Stage-2) — no
            // wall tracked at spawn (mirrors retail's null
            // LastKnownContactPlane before the first contact).
            last_known_wall_normal: None,
            // Physics deep-dive 2026-06-02 (precipice_slide re-entry) —
            // no backup pose at spawn.
            backup_pose_for_step_down: None,
        }
    }

    /// Compute the bludgeon-type damage a player would take landing
    /// at vertical velocity `landing_vz` m/s (negative = downward).
    /// Mirrors ACE's `Player_Move.HandleFallingDamage`:
    ///
    /// ```text
    /// overspeed = 11.25434 + currVz + 4.5       // 11.25434 is the
    ///                                              hardcoded "jump
    ///                                              velocity" baseline
    ///                                              in ACE Player_Move
    /// ratio = -overspeed / 11.25434
    /// damage = if ratio > 0 { ratio * 87.293810 } else { 0 }
    /// ```
    ///
    /// Threshold: damage starts when `landing_vz < -15.75 m/s` (about
    /// the velocity from a 12.6m free-fall). Normal jumps in this
    /// client land at ~−4 to −10 m/s — well under the threshold, so
    /// damage is 0. Damage applies when the player falls off a
    /// cliff or from a high jump that descends past the launch level.
    ///
    /// **Client-side use is documentation only.** ACE applies fall
    /// damage server-side from `PhysicsObj.Velocity` (set by our
    /// `GameAction::Jump` packet's velocity field + server-side
    /// gravity integration) and broadcasts the resulting health
    /// update + chat message via the existing vital/chat channels —
    /// the client's normal recv loop picks them up without any
    /// jump-specific code. Predicting damage client-side risks
    /// HUD desync if the server's velocity calc diverges from ours.
    ///
    /// Source: `~/ace-server/Source/ACE.Server/WorldObjects/Player_Move.cs`
    /// (`HandleFallingDamage`).
    pub fn compute_fall_damage(landing_vz: f32) -> f32 {
        const JUMP_VELOCITY: f32 = 11.25434;
        const LEEWAY: f32 = 4.5;
        const DAMAGE_SCALE: f32 = 87.293810;
        let overspeed = JUMP_VELOCITY + landing_vz + LEEWAY;
        let ratio = -overspeed / JUMP_VELOCITY;
        if ratio > 0.0 {
            ratio * DAMAGE_SCALE
        } else {
            0.0
        }
    }

    /// Stamina cost for a jump. Mirrors ACE's
    /// `MovementSystem.JumpStaminaCost`:
    ///   - non-PK: `ceil((burden + 0.5) * power * 8 + 2)`
    ///   - PK: `(power + 1) * 100`
    ///
    /// Source: `~/ace-server/Source/ACE.Server/Physics/Animation/MovementSystem.cs`.
    ///
    /// ACE's `HandleActionJump` reads this and applies via
    /// `UpdateVitalDelta(Stamina, -staminaCost)`. We mirror the cost
    /// calc client-side so we can gate the jump on the player having
    /// enough stamina (ACE would reduce velocity if stamina were
    /// short, but the relevant branch is commented out — see
    /// `Player.cs:866`) and so the visible stamina bar tracks the
    /// expected deduction before the server confirms.
    pub fn jump_stamina_cost(power: f32, burden: f32, pk: bool) -> u32 {
        let power = power.clamp(0.0, 1.0);
        if pk {
            ((power + 1.0) * 100.0) as u32
        } else {
            ((burden + 0.5) * power * 8.0 + 2.0).ceil() as u32
        }
    }

    /// Compute the upward Z velocity for a jump with the given
    /// power, burden, and Jump skill. Mirrors ACE's
    /// `WeenieObject.InqJumpVelocity` chain:
    ///   1. `MovementSystem.GetJumpHeight(burden, jumpSkill, power, 1.0)`
    ///   2. `velocity_z = sqrt(height * 19.6)` (kinematic with g=9.8)
    ///
    /// `power` is the jump-press extent in `[0.0, 1.0]`. Burden mod
    /// is 1.0 for burden < 1.0 (typical player), so a starter
    /// character (jumpSkill=50) at full power lifts ≈ 0.87m
    /// (≈4.13 m/s); jumpSkill=400 lifts ≈ 5.27m (≈10.16 m/s).
    /// Source: `~/ace-server/Source/ACE.Server/Physics/Animation/MovementSystem.cs`.
    pub fn compute_jump_velocity_z(power: f32, burden: f32, jump_skill: u32) -> f32 {
        let power = power.clamp(0.0, 1.0);
        let burden_mod = if burden < 1.0 {
            1.0
        } else if burden < 2.0 {
            2.0 - burden
        } else {
            // ACE's > 2.0 branch returns 0; matched but never hit
            // for normal play.
            0.0
        };
        let skill = jump_skill as f32;
        let height = burden_mod * (skill / (skill + 1300.0) * 22.2 + 0.05) * power;
        let height = height.max(0.35); // ACE min clamp
        (height * 19.6).sqrt()
    }

    /// Begin a jump locally. Sets [`is_airborne`] and stamps the
    /// initial vertical velocity. No-op when already airborne — ACE
    /// does not allow double-jumps; the recv-loop gate also enforces
    /// this so the wire packet is only sent for grounded jumps.
    pub fn begin_jump(&mut self, velocity_z: f32) {
        if self.is_airborne {
            return;
        }
        self.is_airborne = true;
        // Wave 5 Phase 5.1 (2026-05-26) — flag this airborne phase as
        // jump-initiated so the recv-loop animation emission can choose
        // Jump clip vs Falling cycle. The Jump clip is broadcast from
        // the JS keyup handler at `index.html:7755`; this flag prevents
        // the parallel Falling emission from clobbering it.
        self.is_jumping = true;
        self.vertical_velocity = velocity_z;
        // Wave 10 Phase 10.2 (2026-05-26) — stamp the substate so the
        // motion_allows_jump gate sees `Jump` after dispatch (Jump
        // itself is not in PhatSDK's blocked set; the is_airborne
        // flag is what stops the second-jump press).
        self.current_substate = MotionCommandCode::JUMP;
    }

    /// Begin an unjumped airborne fall — i.e., the player walked off a
    /// ledge or stepped off a cliff. Wave 5 Phase 5.1 (movement-
    /// animation overhaul, 2026-05-26). Sets [`is_airborne`] without
    /// the [`is_jumping`] marker so the recv-loop emission routes
    /// `Falling (0x40000015)` to the renderer instead of leaving the
    /// rig T-posed (the prior bug — the `setAirborne` overlay deleted
    /// in Wave 1 Phase 1.2 was the only visual cue for falling).
    /// `vertical_velocity` starts at 0 because the fall is acceleration-
    /// driven; the integrator decrements it by `9.8 * dt` per tick.
    /// No-op when already airborne.
    pub fn begin_fall(&mut self) {
        if self.is_airborne {
            return;
        }
        self.is_airborne = true;
        self.is_jumping = false;
        self.vertical_velocity = 0.0;
        // Wave 10 Phase 10.2 (2026-05-26) — stamp the in-air substate.
        // Falling itself isn't in PhatSDK's blocked set; is_airborne
        // is what gates a mid-air re-jump.
        self.current_substate = MotionCommandCode::FALLING;
    }

    /// Clear the airborne state on landing or teleport.
    pub fn land(&mut self) {
        self.is_airborne = false;
        self.is_jumping = false;
        self.vertical_velocity = 0.0;
        // Physics deep-dive 2026-06-01 (cliff_slide Stage-2) — touchdown
        // is a contact reset, so the wall tracked while airborne (if any)
        // is no longer the `LastKnownContactPlane` for the next grounded
        // slice. Mirrors retail invalidating
        // `CollisionInfo.LastKnownContactPlane` on a contact change.
        self.last_known_wall_normal = None;
        // Wave 10 Phase 10.2 (2026-05-26) — fall back to Ready on
        // touchdown. Mirrors PhatSDK `apply_interpreted_movement` →
        // `DoInterpretedMotion(0x41000003)` when no forward command
        // is queued (`MovementManager.cpp:776-779`). If the player
        // is holding W/A/S/D, the next manual-drive tick will
        // overwrite this with WalkForward/etc via the wire-side
        // UpdateMotion round-trip (`update_current_substate_from_low16`).
        self.current_substate = MotionCommandCode::READY;
    }

    /// Wave 10 Phase 10.2 (2026-05-26) — assign a new substate from a
    /// low-16 [`InterpretedMotionCommand`] value. Used by the recv-loop
    /// `UpdateMotion` handler when ACE broadcasts a self-motion edge
    /// (e.g. `/sit` → Sitting, `/use` → Reload, spell cast → AimLevel
    /// or MagicPowerUp*). When the low-16 doesn't map to a known
    /// 32-bit `MotionCommand`, the previous substate is preserved
    /// (permissive default — never silently block jumps on an unknown
    /// command).
    pub fn update_current_substate_from_low16(&mut self, low16: u16) {
        if let Some(full) = expand_motion_command_low16(low16) {
            self.current_substate = full;
        }
    }

    pub fn vitae(&self) -> f32 {
        crate::magic::get_total_vitae(&self.enchantments)
    }

    pub fn local_position_overlay(
        &self,
        position_type: PositionType,
    ) -> Option<holtburger_common::position::WorldPosition> {
        self.local_position_overlays.get(&position_type).copied()
    }

    pub fn set_local_position_overlay(
        &mut self,
        position_type: PositionType,
        position: holtburger_common::position::WorldPosition,
    ) {
        self.local_position_overlays.insert(position_type, position);
    }
}

impl PlayerState {
    /// Adds an item to the player's inventory tracking.
    pub fn add_to_inventory(&mut self, item: Guid) {
        self.inventory.insert(item);
    }

    /// Removes an item from the player's inventory tracking and equipment.
    pub fn remove_from_inventory(&mut self, item: Guid) {
        self.inventory.remove(&item);
        self.equipment.remove(&item);
    }

    /// Marks an item as equipped.
    pub fn wield_item(&mut self, item: Guid, slot: EquipMask) {
        self.inventory.insert(item);
        self.equipment.insert(item, slot);
    }

    /// Marks an item as unequipped.
    pub fn unwield_item(&mut self, item: Guid) {
        self.equipment.remove(&item);
    }

    pub fn attribute_snapshot(&self) -> Vec<stats::Attribute> {
        let mut attr_objs: Vec<_> = self.attributes.values().cloned().collect();
        attr_objs.sort_by_key(|a| a.attr_type as u32);
        attr_objs
    }

    pub fn vital_snapshot(&self) -> Vec<stats::Vital> {
        let mut vitals: Vec<_> = self.vitals.values().cloned().collect();
        vitals.sort_by_key(|v| v.vital_type as u32);
        vitals
    }

    pub fn skill_snapshot(&self) -> Vec<stats::Skill> {
        let mut skills: Vec<_> = self.skills.values().cloned().collect();
        skills.sort_by_key(|s| s.skill_type as u32);
        skills
    }

    pub fn character_option_enabled(&self, option: CharacterOption) -> bool {
        match character_option_mask(option) {
            CharacterOptionMask::Options1(flag) => self.options1.contains(flag),
            CharacterOptionMask::Options2(flag) => self.options2.contains(flag),
        }
    }

    pub fn set_character_option_enabled(&mut self, option: CharacterOption, enabled: bool) {
        match character_option_mask(option) {
            CharacterOptionMask::Options1(flag) => {
                self.options1.set(flag, enabled);
            }
            CharacterOptionMask::Options2(flag) => {
                self.options2.set(flag, enabled);
            }
        }
    }
}

#[cfg(test)]
mod jump_tests {
    use super::PlayerState;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 0.05
    }

    #[test]
    fn starter_character_jump_velocity_matches_ace_formula() {
        // jumpSkill=50, burden=0.5 (mod 1.0), power=1.0:
        //   height = 1.0 * (50/1350 * 22.2 + 0.05) = 0.872m
        //   vz = sqrt(0.872 * 19.6) ≈ 4.13 m/s
        let vz = PlayerState::compute_jump_velocity_z(1.0, 0.5, 50);
        assert!(close(vz, 4.13), "expected ~4.13 m/s, got {vz}");
    }

    #[test]
    fn skilled_jumper_velocity_matches_ace_formula() {
        // jumpSkill=400, burden=0.5 (mod 1.0), power=1.0:
        //   height = 1.0 * (400/1700 * 22.2 + 0.05) = 5.27m
        //   vz = sqrt(5.27 * 19.6) ≈ 10.16 m/s
        let vz = PlayerState::compute_jump_velocity_z(1.0, 0.5, 400);
        assert!(close(vz, 10.16), "expected ~10.16 m/s, got {vz}");
    }

    #[test]
    fn min_jump_height_clamp_floors_at_35cm() {
        // power=0.0 + zero skill → ACE clamps to 0.35m floor
        //   vz = sqrt(0.35 * 19.6) ≈ 2.62 m/s
        let vz = PlayerState::compute_jump_velocity_z(0.0, 0.5, 0);
        assert!(close(vz, 2.62), "min-clamp vz: {vz}");
    }

    #[test]
    fn overburden_kills_jump_height() {
        // burden > 2.0 → BurdenMod = 0 → height clamps to 0.35m floor.
        let vz = PlayerState::compute_jump_velocity_z(1.0, 2.5, 100);
        assert!(close(vz, 2.62), "overburden vz: {vz}");
    }

    #[test]
    fn begin_jump_sets_airborne_and_velocity() {
        let mut p = PlayerState::new();
        assert!(!p.is_airborne);
        p.begin_jump(5.0);
        assert!(p.is_airborne);
        assert_eq!(p.vertical_velocity, 5.0);
    }

    #[test]
    fn begin_jump_is_noop_when_already_airborne() {
        let mut p = PlayerState::new();
        p.begin_jump(5.0);
        p.begin_jump(99.0); // second press, mid-air
        assert_eq!(p.vertical_velocity, 5.0, "double-jump must not retrigger");
    }

    #[test]
    fn land_clears_airborne() {
        let mut p = PlayerState::new();
        p.begin_jump(5.0);
        p.land();
        assert!(!p.is_airborne);
        assert_eq!(p.vertical_velocity, 0.0);
    }

    /// Wave 5 Phase 5.1 (2026-05-26).
    #[test]
    fn begin_jump_marks_is_jumping() {
        let mut p = PlayerState::new();
        assert!(!p.is_jumping);
        p.begin_jump(5.0);
        assert!(p.is_airborne);
        assert!(p.is_jumping, "begin_jump must set is_jumping");
    }

    /// Wave 5 Phase 5.1 (2026-05-26).
    #[test]
    fn begin_fall_marks_airborne_without_jumping() {
        let mut p = PlayerState::new();
        p.begin_fall();
        assert!(p.is_airborne, "begin_fall must set is_airborne");
        assert!(!p.is_jumping, "begin_fall must NOT set is_jumping");
        assert_eq!(
            p.vertical_velocity, 0.0,
            "ledge walk-off starts with zero vz"
        );
    }

    /// Wave 5 Phase 5.1 (2026-05-26).
    #[test]
    fn begin_fall_is_noop_when_already_airborne() {
        let mut p = PlayerState::new();
        p.begin_jump(5.0);
        p.begin_fall();
        assert!(p.is_jumping, "begin_fall must not overwrite an active jump");
        assert_eq!(p.vertical_velocity, 5.0);
    }

    /// Wave 5 Phase 5.1 (2026-05-26).
    #[test]
    fn land_clears_is_jumping() {
        let mut p = PlayerState::new();
        p.begin_jump(5.0);
        assert!(p.is_jumping);
        p.land();
        assert!(!p.is_jumping, "land must clear is_jumping");
    }

    #[test]
    fn stamina_cost_non_pk_baseline() {
        // ACE: ceil((0.5 + 0.5) * 1.0 * 8 + 2) = ceil(10) = 10
        assert_eq!(PlayerState::jump_stamina_cost(1.0, 0.5, false), 10);
    }

    #[test]
    fn stamina_cost_non_pk_heavy_burden() {
        // burden=1.5: ceil((1.5+0.5)*1*8+2) = ceil(18) = 18
        assert_eq!(PlayerState::jump_stamina_cost(1.0, 1.5, false), 18);
    }

    #[test]
    fn stamina_cost_non_pk_low_power() {
        // power=0.25: ceil((0.5+0.5)*0.25*8+2) = ceil(4) = 4
        assert_eq!(PlayerState::jump_stamina_cost(0.25, 0.5, false), 4);
    }

    #[test]
    fn stamina_cost_pk_full_power() {
        // PK: (1.0 + 1.0) * 100 = 200
        assert_eq!(PlayerState::jump_stamina_cost(1.0, 0.5, true), 200);
    }

    #[test]
    fn stamina_cost_pk_zero_power() {
        // PK: (0 + 1) * 100 = 100 (PK pays even for nothing)
        assert_eq!(PlayerState::jump_stamina_cost(0.0, 0.5, true), 100);
    }

    #[test]
    fn stamina_cost_clamps_power_to_unit() {
        assert_eq!(
            PlayerState::jump_stamina_cost(1.5, 0.5, false),
            PlayerState::jump_stamina_cost(1.0, 0.5, false)
        );
    }

    #[test]
    fn fall_damage_below_threshold_is_zero() {
        // Normal jump landing velocities: ~-4 to -10 m/s. All below
        // ACE's threshold (-15.75 m/s, where overspeed crosses 0).
        assert_eq!(PlayerState::compute_fall_damage(0.0), 0.0);
        assert_eq!(PlayerState::compute_fall_damage(-5.0), 0.0);
        assert_eq!(PlayerState::compute_fall_damage(-10.0), 0.0);
        assert_eq!(PlayerState::compute_fall_damage(-15.7), 0.0);
    }

    #[test]
    fn fall_damage_at_threshold_starts_climbing() {
        // overspeed = 11.254 + (-20) + 4.5 = -4.246
        // ratio = 4.246 / 11.254 ≈ 0.377
        // damage = 0.377 * 87.29 ≈ 32.92
        let d = PlayerState::compute_fall_damage(-20.0);
        assert!((d - 32.92).abs() < 0.1, "got {d}");
    }

    #[test]
    fn fall_damage_high_velocity_lethal_range() {
        // Falling from a 50m+ cliff: vz ≈ -31 m/s
        // overspeed = 11.254 + (-31) + 4.5 = -15.246
        // ratio = 1.355
        // damage = 1.355 * 87.29 ≈ 118.3 (likely lethal for low HP)
        let d = PlayerState::compute_fall_damage(-31.0);
        assert!((d - 118.3).abs() < 0.5, "got {d}");
    }
}
