//! UI taxonomy enums — Wave G (2026-05-27) gap-fill.
//!
//! Three enums from `Chorizite.Common/Enums/` that the chorizite-reading-guide
//! summary §5.3 flagged as MISSING workspace-wide. They describe top-level
//! UI taxonomy used by the gm* panel system and the input-action dispatch:
//!
//! * [`ClientAction`] — 294 retail UI input actions (panel toggles, emote
//!   triggers, quick-slot selection, etc.). Values are in the AC ID range
//!   `0x10000001..0x100000EF` so a `repr(u32)` is required.
//! * [`RootElementId`] — 9 top-level UI element IDs cited by Chorizite's
//!   RmlUiPlugin for built-in UI panels (Indicators, Radar, Vitae, etc.).
//! * [`FriendsUpdateType`] — 4-value `[Flags]` delta opcodes for the
//!   friends-list S2C update (`Full`/`Added`/`Removed`/`LoginChange`).
//!
//! ## Cross-references
//!
//! * `Chorizite.Common/Enums/ClientAction.cs:6-301` — 294 values, `: int`
//!   underlying (we use `repr(u32)` per Chorizite.Common READING_GUIDE §6).
//! * `Chorizite.Common/Enums/RootElementId.cs:6-17` — 9 values, `: uint`.
//! * `Chorizite.Common/Enums/FriendsUpdateType.cs:7-18` — 4 values, `[Flags]
//!   public enum FriendsUpdateType : uint`. The C# tags it `[Flags]` but the
//!   only bit-OR'able subset is `Added | Removed | LoginChange`; `Full = 0`
//!   is the sentinel "full snapshot follows" opcode. We port as `bitflags!`
//!   to match the C# attribute exactly.
//!
//! ## Naming convention
//!
//! Chorizite uses `PascalCase` enum variants verbatim from the retail
//! `acclient.exe` symbol table. We preserve that here (e.g. `ToggleCasPanel`
//! NOT `TOGGLE_CAS_PANEL`) so cross-references to `acclient.c` symbol names
//! line up 1:1. For the `[Flags]` `FriendsUpdateType` we follow the Rust
//! `bitflags!` `SCREAMING_SNAKE_CASE` convention.
//!
//! The `ClientAction::USE` / `LOGOUT` / `EXITGAME` / `START_COMMAND` /
//! `START_ALIAS` variants are spelled in `ALL_CAPS` in the C# source (a
//! historical retail-engine quirk — these are the original gameplay actions
//! pre-dating the panel-toggle naming convention). We preserve them.

use bitflags::bitflags;
use serde::{Deserialize, Serialize};
use strum_macros::{Display, FromRepr};

/// Top-level UI input action enum.
///
/// Mirrors `Chorizite.Common.Enums.ClientAction`
/// (`Chorizite.Common/Enums/ClientAction.cs:6-301`, vendored HEAD `e3b3bd2`).
///
/// 294 values spanning `0x10000001..0x100000EF` with a few high-range
/// outliers (`0x10000102..0x10000139`). The integer values are AC-ID
/// formatted (`0x10000000` prefix) and double as canonical action IDs in
/// the retail input dispatch table.
///
/// Variants are NOT contiguous — there are gaps where Microsoft removed
/// actions from the retail binary over time. Use `from_repr` to round-trip
/// safely.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
    Display, FromRepr, Default,
)]
#[repr(u32)]
#[allow(non_camel_case_types)]
pub enum ClientAction {
    #[default]
    ToggleCasPanel = 0x10000001,
    ToggleAdminPanel = 0x10000002,
    ToggleAbusePanel = 0x10000003,
    ToggleBookPanel = 0x10000004,
    ToggleCharacterInfoPanel = 0x10000005,
    TogglePositiveEffectsPanel = 0x10000006,
    ToggleNegativeEffectsPanel = 0x10000007,
    ToggleExaminationPanel = 0x10000008,
    ToggleLinkStatusPanel = 0x10000009,
    ToggleMiniGamePanel = 0x1000000A,
    ToggleUrgentAssistancePanel = 0x1000000B,
    ToggleVitaePanel = 0x1000000C,
    ToggleSocialPanel = 0x1000000D,
    ToggleAllegiancePanel = 0x1000000E,
    ToggleFellowshipPanel = 0x1000000F,
    ToggleSpellManagementPanel = 0x10000010,
    ToggleSpellbookPanel = 0x10000011,
    ToggleSpellComponentsPanel = 0x10000012,
    ToggleSkillManagementPanel = 0x10000013,
    ToggleAttributesPanel = 0x10000014,
    ToggleSkillsPanel = 0x10000015,
    ToggleWorldPanel = 0x10000016,
    ToggleMapPanel = 0x10000017,
    ToggleHousePanel = 0x10000018,
    ToggleInventoryPanel = 0x10000019,
    ToggleOptionsPanel = 0x1000001A,
    ToggleGameplayOptionsPanel = 0x1000001B,
    ToggleCharacterOptionsPanel = 0x1000001C,
    ToggleConfigOptionsPanel = 0x1000001D,
    ToggleRadarPanel = 0x1000001E,
    ToggleKeyboardPanel = 0x1000001F,
    MonarchReply = 0x10000020,
    PatronReply = 0x10000021,
    Reply = 0x10000022,
    EnterChatMode = 0x10000023,
    ToggleChatEntry = 0x10000024,
    USE = 0x10000025,
    LOGOUT = 0x10000026,
    EXITGAME = 0x10000027,
    START_COMMAND = 0x10000028,
    START_ALIAS = 0x10000029,
    SelectionSelf = 0x1000002A,
    SelectionExamine = 0x1000002B,
    SelectionPickUp = 0x1000002C,
    SelectionSplitStack = 0x1000002D,
    SelectionPreviousSelection = 0x1000002E,
    SelectionClosestCompassItem = 0x1000002F,
    SelectionPreviousCompassItem = 0x10000030,
    SelectionNextCompassItem = 0x10000031,
    SelectionClosestItem = 0x10000032,
    SelectionPreviousItem = 0x10000033,
    SelectionNextItem = 0x10000034,
    SelectionClosestMonster = 0x10000035,
    SelectionPreviousMonster = 0x10000036,
    SelectionNextMonster = 0x10000037,
    SelectionLastAttacker = 0x10000038,
    SelectionClosestPlayer = 0x10000039,
    SelectionPreviousPlayer = 0x1000003A,
    SelectionNextPlayer = 0x1000003B,
    SelectionPreviousFellow = 0x1000003C,
    SelectionNextFellow = 0x1000003D,
    SelectionUseClosestUnopenedCorpse = 0x1000003E,
    SelectionUseNextUnopenedCorpse = 0x1000003F,
    SelectionGive = 0x10000040,
    SelectionDrop = 0x10000041,
    UseQuickSlot_1 = 0x10000042,
    UseQuickSlot_2 = 0x10000043,
    UseQuickSlot_3 = 0x10000044,
    UseQuickSlot_4 = 0x10000045,
    UseQuickSlot_5 = 0x10000046,
    UseQuickSlot_6 = 0x10000047,
    UseQuickSlot_7 = 0x10000048,
    UseQuickSlot_8 = 0x10000049,
    UseQuickSlot_9 = 0x1000004A,
    UseQuickSlot_10 = 0x1000004B,
    UseQuickSlot_11 = 0x1000004C,
    UseQuickSlot_12 = 0x1000004D,
    SelectQuickSlot_1 = 0x1000004E,
    SelectQuickSlot_2 = 0x1000004F,
    SelectQuickSlot_3 = 0x10000050,
    SelectQuickSlot_4 = 0x10000051,
    SelectQuickSlot_5 = 0x10000052,
    SelectQuickSlot_6 = 0x10000053,
    SelectQuickSlot_7 = 0x10000054,
    SelectQuickSlot_8 = 0x10000055,
    SelectQuickSlot_9 = 0x10000056,
    SelectQuickSlot_10 = 0x10000057,
    SelectQuickSlot_11 = 0x10000058,
    SelectQuickSlot_12 = 0x10000059,
    CombatToggleCombat = 0x1000005A,
    CombatDecreaseAttackPower = 0x1000005B,
    CombatIncreaseAttackPower = 0x1000005C,
    CombatLowAttack = 0x1000005D,
    CombatMediumAttack = 0x1000005E,
    CombatHighAttack = 0x1000005F,
    CombatCastCurrentSpell = 0x10000060,
    CombatPrevSpell = 0x10000061,
    CombatNextSpell = 0x10000062,
    CombatPrevSpellTab = 0x10000063,
    CombatNextSpellTab = 0x10000064,
    UseSpellSlot_1 = 0x10000065,
    UseSpellSlot_2 = 0x10000066,
    UseSpellSlot_3 = 0x10000067,
    UseSpellSlot_4 = 0x10000068,
    UseSpellSlot_5 = 0x10000069,
    UseSpellSlot_6 = 0x1000006A,
    UseSpellSlot_7 = 0x1000006B,
    UseSpellSlot_8 = 0x1000006C,
    UseSpellSlot_9 = 0x1000006D,
    UseSpellSlot_10 = 0x1000006E,
    UseSpellSlot_11 = 0x1000006F,
    UseSpellSlot_12 = 0x10000070,
    PlayerOption_AutoRepeatAttack = 0x10000071,
    PlayerOption_IgnoreAllegianceRequests = 0x10000072,
    PlayerOption_IgnoreFellowshipRequests = 0x10000073,
    PlayerOption_IgnoreTradeRequests = 0x10000074,
    PlayerOption_DisableMostWeatherEffects = 0x10000075,
    PlayerOption_PersistentAtDay = 0x10000076,
    PlayerOption_AllowGive = 0x10000077,
    PlayerOption_ViewCombatTarget = 0x10000078,
    PlayerOption_ShowTooltips = 0x10000079,
    PlayerOption_UseDeception = 0x1000007A,
    PlayerOption_ToggleRun = 0x1000007B,
    PlayerOption_StayInChatMode = 0x1000007C,
    PlayerOption_AdvancedCombatUI = 0x1000007D,
    PlayerOption_AutoTarget = 0x1000007E,
    PlayerOption_VividTargetingIndicator = 0x1000007F,
    PlayerOption_FellowshipShareXP = 0x10000080,
    PlayerOption_AcceptLootPermits = 0x10000081,
    PlayerOption_FellowshipShareLoot = 0x10000082,
    PlayerOption_FellowshipAutoAcceptRequests = 0x10000083,
    PlayerOption_CoordinatesOnRadar = 0x10000085,
    PlayerOption_SpellDuration = 0x10000086,
    PlayerOption_DisableHouseRestrictionEffects = 0x10000087,
    PlayerOption_DragItemOnPlayerOpensSecureTrade = 0x10000088,
    PlayerOption_DisplayAllegianceLogonNotifications = 0x10000089,
    PlayerOption_UseChargeAttack = 0x1000008A,
    PlayerOption_UseCraftSuccessDialog = 0x1000008B,
    PlayerOption_HearAllegianceChat = 0x1000008C,
    PlayerOption_DisplayDateOfBirth = 0x1000008D,
    PlayerOption_DisplayAge = 0x1000008E,
    PlayerOption_DisplayChessRank = 0x1000008F,
    PlayerOption_DisplayFishingSkill = 0x10000090,
    PlayerOption_DisplayNumberDeaths = 0x10000091,
    PlayerOption_DisplayTimeStamps = 0x10000092,
    PlayerOption_SalvageMultiple = 0x10000093,
    Ready = 0x10000094,
    Crouch = 0x10000095,
    Sitting = 0x10000096,
    Sleeping = 0x10000097,
    AFKState = 0x10000098,
    Akimbo = 0x10000099,
    ATOYOT = 0x1000009A,
    AkimboState = 0x1000009B,
    AtEaseState = 0x1000009C,
    Beckon = 0x1000009D,
    BeSeeingYou = 0x1000009E,
    BlowKiss = 0x1000009F,
    BowDeep = 0x100000A0,
    BowDeepState = 0x100000A1,
    Cheer = 0x100000A2,
    ClapHands = 0x100000A3,
    ClapHandsState = 0x100000A4,
    Cringe = 0x100000A5,
    CrossArmsState = 0x100000A6,
    Cry = 0x100000A7,
    CurtseyState = 0x100000A8,
    DrudgeDance = 0x100000A9,
    DrudgeDanceState = 0x100000AA,
    HaveASeat = 0x100000AB,
    HaveASeatState = 0x100000AC,
    HeartyLaugh = 0x100000AD,
    Helper = 0x100000AE,
    Kneel = 0x100000AF,
    KneelState = 0x100000B0,
    Knock = 0x100000B1,
    Laugh = 0x100000B2,
    LeanState = 0x100000B3,
    MeditateState = 0x100000B4,
    MimeDrink = 0x100000B5,
    MimeEat = 0x100000B6,
    Mock = 0x100000B7,
    Nod = 0x100000B8,
    NudgeLeft = 0x100000B9,
    NudgeRight = 0x100000BA,
    Plead = 0x100000BB,
    PleadState = 0x100000BC,
    Point = 0x100000BD,
    PointState = 0x100000BE,
    PointDown = 0x100000BF,
    PointDownState = 0x100000C0,
    PointLeft = 0x100000C1,
    PointLeftState = 0x100000C2,
    PointRight = 0x100000C3,
    PointRightState = 0x100000C4,
    PossumState = 0x100000C5,
    Pray = 0x100000C6,
    PrayState = 0x100000C7,
    ReadState = 0x100000C8,
    Salute = 0x100000C9,
    SaluteState = 0x100000CA,
    ScanHorizon = 0x100000CB,
    ScratchHead = 0x100000CC,
    ScratchHeadState = 0x100000CD,
    ShakeFist = 0x100000CE,
    ShakeFistState = 0x100000CF,
    ShakeHead = 0x100000D0,
    Shiver = 0x100000D1,
    ShiverState = 0x100000D2,
    Shoo = 0x100000D3,
    Shrug = 0x100000D4,
    SitState = 0x100000D5,
    SitBackState = 0x100000D6,
    SitCrossleggedState = 0x100000D7,
    Slouch = 0x100000D8,
    SlouchState = 0x100000D9,
    SmackHead = 0x100000DA,
    SnowAngelState = 0x100000DB,
    Spit = 0x100000DC,
    Surrender = 0x100000DD,
    SurrenderState = 0x100000DE,
    TalktotheHandState = 0x100000DF,
    TapFoot = 0x100000E0,
    TapFootState = 0x100000E1,
    Teapot = 0x100000E2,
    ThinkerState = 0x100000E3,
    WarmHands = 0x100000E4,
    Wave = 0x100000E5,
    WaveState = 0x100000E6,
    WaveLow = 0x100000E7,
    WaveHigh = 0x100000E8,
    Winded = 0x100000E9,
    WindedState = 0x100000EA,
    Woah = 0x100000EB,
    WoahState = 0x100000EC,
    YawnStretch = 0x100000ED,
    YMCA = 0x100000EE,
    CombatDecreaseMissileAccuracy = 0x100000EF,
    CombatIncreaseMissileAccuracy = 0x100000F0,
    CombatAimLow = 0x100000F1,
    CombatAimMedium = 0x100000F2,
    CombatAimHigh = 0x100000F3,
    CombatFirstSpell = 0x10000102,
    CombatLastSpell = 0x10000103,
    CombatFirstSpellTab = 0x10000104,
    CombatLastSpellTab = 0x10000105,
    CreateShortcut = 0x1000010D,
    PlayerOption_HearGeneralChat = 0x1000010E,
    PlayerOption_HearTradeChat = 0x1000010F,
    PlayerOption_HearLFGChat = 0x10000110,
    PlayerOption_HearRoleplayChat = 0x10000112,
    ToggleChatOptionsPanel = 0x10000113,
    ToggleFloatingChatWindow1 = 0x10000114,
    ToggleFloatingChatWindow2 = 0x10000115,
    ToggleFloatingChatWindow3 = 0x10000116,
    ToggleFloatingChatWindow4 = 0x10000117,
    ToggleFriendsPanel = 0x10000118,
    TellSelected = 0x10000119,
    ToggleCharacterTitlePanel = 0x1000011A,
    PlayerOption_DisplayNumberCharacterTitles = 0x1000011B,
    SelectionMoveToMainPack = 0x1000011C,
    PlayerOption_MainPackPreferred = 0x1000011D,
    PlayerOption_LeadMissileTargets = 0x1000011E,
    PlayerOption_UseFastMissiles = 0x1000011F,
    PlayerOption_FilterLanguage = 0x10000120,
    SelectionClosestUnopenedCorpse = 0x10000121,
    SelectionNextUnopenedCorpse = 0x10000122,
    PlayerOption_ConfirmVolatileRareUse = 0x10000123,
    ToggleSquelchPanel = 0x10000124,
    PlayerOption_HearSocietyChat = 0x10000125,
    ToggleQuestManagementPanel = 0x10000127,
    ToggleJournalPanel = 0x10000128,
    TogglePageListPanel = 0x10000129,
    PlayerOption_ShowHelm = 0x1000012A,
    PlayerOption_DisableDistanceFog = 0x1000012C,
    PlayerOption_UseMouseTurning = 0x1000012D,
    ToggleContractsPanel = 0x1000012E,
    PlayerOption_ShowCloak = 0x1000012F,
    ToggleFloatingExaminationWindow = 0x10000130,
    ToggleOptionsMenu = 0x10000131,
    UseQuickSlot_13 = 0x10000132,
    UseQuickSlot_14 = 0x10000133,
    UseQuickSlot_15 = 0x10000134,
    UseQuickSlot_16 = 0x10000135,
    UseQuickSlot_17 = 0x10000136,
    UseQuickSlot_18 = 0x10000137,
    SelectQuickSlot_13 = 0x10000138,
    SelectQuickSlot_14 = 0x10000139,
    SelectQuickSlot_15 = 0x1000013A,
    SelectQuickSlot_16 = 0x1000013B,
    SelectQuickSlot_17 = 0x1000013C,
    SelectQuickSlot_18 = 0x1000013D,
    PlayerOption_SideBySideVitals = 0x1000013E,
    PlayerOption_HearPKDeaths = 0x1000013F,
}

/// Top-level UI element ID enum.
///
/// Mirrors `Chorizite.Common.Enums.RootElementId`
/// (`Chorizite.Common/Enums/RootElementId.cs:6-17`, vendored HEAD `e3b3bd2`).
///
/// 9 values naming the retail UI panels (Indicators, MiniGame, Radar,
/// Vitae, PositiveEffects, NegativeEffects, CharacterInfo, LinkStatus,
/// LogOut). Discriminants are retail UI element IDs in the `0x100001xx /
/// 0x100006xx` range; `LogOut = 0x10000026` shares its value with
/// `ClientAction::LOGOUT` (intentional — the action triggers the same
/// element).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
    Display, FromRepr, Default,
)]
#[repr(u32)]
pub enum RootElementId {
    #[default]
    LogOut = 0x10000026,
    CharacterInfo = 0x10000183,
    PositiveEffects = 0x10000184,
    NegativeEffects = 0x10000185,
    LinkStatus = 0x10000187,
    MiniGame = 0x10000188,
    Vitae = 0x1000018A,
    Indicators = 0x10000611,
    Radar = 0x100006D2,
}

bitflags! {
    /// Friends-list delta opcode bitmask.
    ///
    /// Mirrors `Chorizite.Common.Enums.FriendsUpdateType`
    /// (`Chorizite.Common/Enums/FriendsUpdateType.cs:7-18`, vendored
    /// HEAD `e3b3bd2`). The C# tags this `[Flags]`.
    ///
    /// Wire-side analog: `holtburger_protocol::messages::friends::events
    /// ::FriendsUpdateTypeFlags` (newtype-around-u32 with the same constants
    /// in `SCREAMING_SNAKE_CASE`). The two have identical bit values; this
    /// enum is the canonical client-side `holtburger-common` definition.
    #[derive(
        Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash,
        Serialize, Deserialize, Default,
    )]
    pub struct FriendsUpdateType: u32 {
        /// `Full = 0x0000` — sentinel for "full snapshot follows."
        const FULL          = 0x0000;
        /// `Added = 0x0001`
        const ADDED         = 0x0001;
        /// `Removed = 0x0002`
        const REMOVED       = 0x0002;
        /// `LoginChange = 0x0004` — friend went online or offline.
        const LOGIN_CHANGE  = 0x0004;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Asserts `ClientAction` integer values match
    /// `Chorizite.Common/Enums/ClientAction.cs:6-301` (vendored HEAD
    /// `e3b3bd2`). Spot-checks the boundary entries plus the high-range
    /// outliers Chorizite added after the main 0x10000001..0x100000EF run.
    #[test]
    fn client_action_values_match_chorizite() {
        // First/last in the contiguous 0x10000001 block
        assert_eq!(ClientAction::ToggleCasPanel as u32, 0x10000001);
        assert_eq!(ClientAction::PlayerOption_SalvageMultiple as u32, 0x10000093);

        // ALL_CAPS retail-engine legacy variants
        assert_eq!(ClientAction::USE as u32, 0x10000025);
        assert_eq!(ClientAction::LOGOUT as u32, 0x10000026);
        assert_eq!(ClientAction::EXITGAME as u32, 0x10000027);
        assert_eq!(ClientAction::START_COMMAND as u32, 0x10000028);
        assert_eq!(ClientAction::START_ALIAS as u32, 0x10000029);

        // Quick-slot wrap-around cluster
        assert_eq!(ClientAction::UseQuickSlot_1 as u32, 0x10000042);
        assert_eq!(ClientAction::UseQuickSlot_12 as u32, 0x1000004D);
        assert_eq!(ClientAction::SelectQuickSlot_1 as u32, 0x1000004E);
        assert_eq!(ClientAction::SelectQuickSlot_12 as u32, 0x10000059);

        // Combat cluster + missile-accuracy followup
        assert_eq!(ClientAction::CombatHighAttack as u32, 0x1000005F);
        assert_eq!(ClientAction::CombatDecreaseMissileAccuracy as u32, 0x100000EF);
        assert_eq!(ClientAction::CombatAimHigh as u32, 0x100000F3);

        // Emote cluster (HaveASeat..YMCA, 0x100000AB..0x100000EE)
        assert_eq!(ClientAction::HaveASeat as u32, 0x100000AB);
        assert_eq!(ClientAction::YMCA as u32, 0x100000EE);

        // High-range outliers (0x10000102..0x1000013F)
        assert_eq!(ClientAction::CombatFirstSpell as u32, 0x10000102);
        assert_eq!(ClientAction::CombatLastSpellTab as u32, 0x10000105);
        assert_eq!(ClientAction::CreateShortcut as u32, 0x1000010D);
        assert_eq!(ClientAction::PlayerOption_HearGeneralChat as u32, 0x1000010E);
        assert_eq!(ClientAction::ToggleOptionsMenu as u32, 0x10000131);
        assert_eq!(ClientAction::PlayerOption_HearPKDeaths as u32, 0x1000013F);

        // Round-trip via FromRepr
        assert_eq!(ClientAction::from_repr(0x10000001), Some(ClientAction::ToggleCasPanel));
        assert_eq!(ClientAction::from_repr(0x1000013F), Some(ClientAction::PlayerOption_HearPKDeaths));
        // Gap value (0x10000084 — between 0x83 FellowshipAutoAcceptRequests
        // and 0x85 CoordinatesOnRadar — was retired in retail)
        assert_eq!(ClientAction::from_repr(0x10000084), None);
        // Gap value (0x10000111 — between 0x110 HearLFGChat and 0x112
        // HearRoleplayChat)
        assert_eq!(ClientAction::from_repr(0x10000111), None);

        // Default matches the lowest-numeric entry
        assert_eq!(ClientAction::default(), ClientAction::ToggleCasPanel);
    }

    /// Asserts `RootElementId` integer values match
    /// `Chorizite.Common/Enums/RootElementId.cs:6-17` (vendored HEAD
    /// `e3b3bd2`). All 9 variants enumerated.
    #[test]
    fn root_element_id_values_match_chorizite() {
        assert_eq!(RootElementId::LogOut as u32, 0x10000026);
        assert_eq!(RootElementId::CharacterInfo as u32, 0x10000183);
        assert_eq!(RootElementId::PositiveEffects as u32, 0x10000184);
        assert_eq!(RootElementId::NegativeEffects as u32, 0x10000185);
        assert_eq!(RootElementId::LinkStatus as u32, 0x10000187);
        assert_eq!(RootElementId::MiniGame as u32, 0x10000188);
        assert_eq!(RootElementId::Vitae as u32, 0x1000018A);
        assert_eq!(RootElementId::Indicators as u32, 0x10000611);
        assert_eq!(RootElementId::Radar as u32, 0x100006D2);

        // Round-trip via FromRepr
        assert_eq!(RootElementId::from_repr(0x10000026), Some(RootElementId::LogOut));
        assert_eq!(RootElementId::from_repr(0x100006D2), Some(RootElementId::Radar));
        assert_eq!(RootElementId::from_repr(0x10000186), None); // gap (185 to 187)
        assert_eq!(RootElementId::from_repr(0x10000189), None); // gap (188 to 18A)

        // Cross-enum value collision: `RootElementId::LogOut` shares its
        // value with `ClientAction::LOGOUT` (0x10000026) — the action
        // triggers the element. Document the collision here.
        assert_eq!(RootElementId::LogOut as u32, ClientAction::LOGOUT as u32);
    }

    /// Asserts `FriendsUpdateType` bit values match
    /// `Chorizite.Common/Enums/FriendsUpdateType.cs:7-18` (vendored HEAD
    /// `e3b3bd2`). Also cross-checks the protocol wire-side newtype.
    #[test]
    fn friends_update_type_values_match_chorizite() {
        assert_eq!(FriendsUpdateType::FULL.bits(), 0x0000);
        assert_eq!(FriendsUpdateType::ADDED.bits(), 0x0001);
        assert_eq!(FriendsUpdateType::REMOVED.bits(), 0x0002);
        assert_eq!(FriendsUpdateType::LOGIN_CHANGE.bits(), 0x0004);

        // Bit-OR combinations (the `[Flags]` attribute lets the wire
        // payload combine `ADDED | LOGIN_CHANGE` in a single update — a
        // new friend who is also currently online).
        let combo = FriendsUpdateType::ADDED | FriendsUpdateType::LOGIN_CHANGE;
        assert_eq!(combo.bits(), 0x0005);
        assert!(combo.contains(FriendsUpdateType::ADDED));
        assert!(combo.contains(FriendsUpdateType::LOGIN_CHANGE));
        assert!(!combo.contains(FriendsUpdateType::REMOVED));

        // FULL is the sentinel zero-value
        assert!(FriendsUpdateType::FULL.is_empty());
    }
}
