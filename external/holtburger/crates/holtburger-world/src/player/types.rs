use crate::stats;
use holtburger_common::{CharacterOption, CharacterOptions1, CharacterOptions2, Guid};
use holtburger_protocol::messages::EquipMask;
use holtburger_protocol::messages::magic::Enchantment;
use holtburger_protocol::messages::movement::{MotionStance, PositionType};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

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
    /// Player's local Z velocity in m/s while [`is_airborne`].
    /// Initialized to the result of [`compute_jump_velocity_z`]
    /// on `Jump` and decremented by `9.8 * dt` per tick (ACE
    /// `MovementSystem.GetJumpHeight` derives height from this same
    /// kinematic — `v = sqrt(h * 19.6)` → `g = 9.8 m/s²`). Reset to
    /// 0.0 on landing or teleport.
    pub vertical_velocity: f32,
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
            vertical_velocity: 0.0,
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
        self.vertical_velocity = velocity_z;
    }

    /// Clear the airborne state on landing or teleport.
    pub fn land(&mut self) {
        self.is_airborne = false;
        self.vertical_velocity = 0.0;
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
}
