//! Emote taxonomy enums — Wave F.6 (2026-05-27) gap-fill.
//!
//! Two enums from `Chorizite.Common/Enums/` that the chorizite-reading-guide
//! summary §5.3 flagged as MISSING from `holtburger-common`. They mirror the
//! AI-emote payload carried by `CEmoteTable` (a member of `CACQualities` /
//! WeenieDesc — NOT a standalone DAT file, see §10 of this module's tests),
//! so they live in a dedicated `emote` module rather than `combat.rs`.
//!
//! ## Cross-references
//!
//! * `Chorizite.Common/Enums/EmoteCategory.cs:5-84` — 0x00..0x26 (39 values).
//!   Identifies WHICH script trigger the NPC is responding to: vendor hails,
//!   death, hear-chat keyword match, quest success/failure, etc.
//! * `Chorizite.Common/Enums/EmoteType.cs:5-251` — 0x00..0x79 (122 values).
//!   Identifies WHAT the script does: `Say`, `Motion`, `CastSpell`, `Goto`,
//!   `AwardXP`, `IncrementMyQuest`, etc.
//!
//! Pairing: a single NPC's `CEmoteTable` maps each `EmoteCategory` (e.g.
//! `Refuse_EmoteCategory`) to a list of `EmoteSet`s, each containing a list
//! of `Emote` records keyed by `EmoteType` (e.g. `Say_EmoteType` to deliver
//! a "I won't take this" line + `Motion_EmoteType` to play the shake-head
//! animation).
//!
//! ## Naming convention
//!
//! Chorizite suffixes ALL variants with `_EmoteCategory` / `_EmoteType`
//! (e.g. `Refuse_EmoteCategory`) — that's redundant under enum-namespacing
//! in Rust (we'd type `EmoteCategory::Refuse_EmoteCategory`). Following
//! `Chorizite.Common` READING_GUIDE §6 idiom mapping precedent — the same
//! pattern used for `SpellType::Enchantment` (vs C# `Enchantment_SpellType`)
//! — we strip the suffix. The integer values match Chorizite byte-for-byte.

use serde::{Deserialize, Serialize};
use strum_macros::{Display, FromRepr};

/// Emote category — identifies the script trigger.
///
/// Mirrors `Chorizite.Common.Enums.EmoteCategory`
/// (`Chorizite.Common/Enums/EmoteCategory.cs:5-84`, vendored HEAD `e3b3bd2`).
///
/// Each NPC's `CEmoteTable` is keyed by this enum. When the server fires
/// a script event (vendor open, death, quest success, etc.) the table is
/// indexed by the matching category to find the per-NPC response.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Display,
    FromRepr, Default,
)]
#[repr(u32)]
pub enum EmoteCategory {
    #[default]
    Invalid = 0x00,
    Refuse = 0x01,
    Vendor = 0x02,
    Death = 0x03,
    Portal = 0x04,
    HeartBeat = 0x05,
    Give = 0x06,
    Use = 0x07,
    Activation = 0x08,
    Generation = 0x09,
    PickUp = 0x0A,
    Drop = 0x0B,
    QuestSuccess = 0x0C,
    QuestFailure = 0x0D,
    Taunt = 0x0E,
    WoundedTaunt = 0x0F,
    KillTaunt = 0x10,
    NewEnemy = 0x11,
    Scream = 0x12,
    Homesick = 0x13,
    ReceiveCritical = 0x14,
    ResistSpell = 0x15,
    TestSuccess = 0x16,
    TestFailure = 0x17,
    HearChat = 0x18,
    Wield = 0x19,
    UnWield = 0x1A,
    EventSuccess = 0x1B,
    EventFailure = 0x1C,
    TestNoQuality = 0x1D,
    QuestNoFellow = 0x1E,
    TestNoFellow = 0x1F,
    GotoSet = 0x20,
    NumFellowsSuccess = 0x21,
    NumFellowsFailure = 0x22,
    NumCharacterTitlesSuccess = 0x23,
    NumCharacterTitlesFailure = 0x24,
    ReceiveLocalSignal = 0x25,
    ReceiveTalkDirect = 0x26,
}

impl EmoteCategory {
    /// Human-readable display name (drops the `_EmoteCategory` suffix
    /// and converts CamelCase to spaced "Quest Success" style).
    pub fn display_name(&self) -> &'static str {
        match self {
            EmoteCategory::Invalid => "Invalid",
            EmoteCategory::Refuse => "Refuse",
            EmoteCategory::Vendor => "Vendor",
            EmoteCategory::Death => "Death",
            EmoteCategory::Portal => "Portal",
            EmoteCategory::HeartBeat => "Heart Beat",
            EmoteCategory::Give => "Give",
            EmoteCategory::Use => "Use",
            EmoteCategory::Activation => "Activation",
            EmoteCategory::Generation => "Generation",
            EmoteCategory::PickUp => "Pick Up",
            EmoteCategory::Drop => "Drop",
            EmoteCategory::QuestSuccess => "Quest Success",
            EmoteCategory::QuestFailure => "Quest Failure",
            EmoteCategory::Taunt => "Taunt",
            EmoteCategory::WoundedTaunt => "Wounded Taunt",
            EmoteCategory::KillTaunt => "Kill Taunt",
            EmoteCategory::NewEnemy => "New Enemy",
            EmoteCategory::Scream => "Scream",
            EmoteCategory::Homesick => "Homesick",
            EmoteCategory::ReceiveCritical => "Receive Critical",
            EmoteCategory::ResistSpell => "Resist Spell",
            EmoteCategory::TestSuccess => "Test Success",
            EmoteCategory::TestFailure => "Test Failure",
            EmoteCategory::HearChat => "Hear Chat",
            EmoteCategory::Wield => "Wield",
            EmoteCategory::UnWield => "Un-Wield",
            EmoteCategory::EventSuccess => "Event Success",
            EmoteCategory::EventFailure => "Event Failure",
            EmoteCategory::TestNoQuality => "Test No Quality",
            EmoteCategory::QuestNoFellow => "Quest No Fellow",
            EmoteCategory::TestNoFellow => "Test No Fellow",
            EmoteCategory::GotoSet => "Goto Set",
            EmoteCategory::NumFellowsSuccess => "Num Fellows Success",
            EmoteCategory::NumFellowsFailure => "Num Fellows Failure",
            EmoteCategory::NumCharacterTitlesSuccess => "Num Character Titles Success",
            EmoteCategory::NumCharacterTitlesFailure => "Num Character Titles Failure",
            EmoteCategory::ReceiveLocalSignal => "Receive Local Signal",
            EmoteCategory::ReceiveTalkDirect => "Receive Talk Direct",
        }
    }
}

/// Emote action type — identifies what the script does.
///
/// Mirrors `Chorizite.Common.Enums.EmoteType`
/// (`Chorizite.Common/Enums/EmoteType.cs:5-251`, vendored HEAD `e3b3bd2`).
///
/// Each `Emote` record inside an `EmoteSet` carries one of these
/// discriminants. The discriminant gates which fields the wire payload
/// carries (see `EmoteSet::Read` switch at `EmoteSet.generated.cs:49`
/// and `Emote::Read` switch at `Emote.generated.cs:89-281`).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Display,
    FromRepr, Default,
)]
#[repr(u32)]
#[allow(clippy::upper_case_acronyms)]
pub enum EmoteType {
    /// Aliases `Invalid_VendorEmoteType = 0x00` per the C# source — same
    /// discriminant, two names. We collapse to one variant.
    #[default]
    Invalid = 0x00,
    Act = 0x01,
    AwardXP = 0x02,
    Give = 0x03,
    MoveHome = 0x04,
    Motion = 0x05,
    Move = 0x06,
    PhysScript = 0x07,
    Say = 0x08,
    Sound = 0x09,
    Tell = 0x0A,
    Turn = 0x0B,
    TurnToTarget = 0x0C,
    TextDirect = 0x0D,
    CastSpell = 0x0E,
    Activate = 0x0F,
    WorldBroadcast = 0x10,
    LocalBroadcast = 0x11,
    DirectBroadcast = 0x12,
    CastSpellInstant = 0x13,
    UpdateQuest = 0x14,
    InqQuest = 0x15,
    StampQuest = 0x16,
    StartEvent = 0x17,
    StopEvent = 0x18,
    BLog = 0x19,
    AdminSpam = 0x1A,
    TeachSpell = 0x1B,
    AwardSkillXP = 0x1C,
    AwardSkillPoints = 0x1D,
    InqQuestSolves = 0x1E,
    EraseQuest = 0x1F,
    DecrementQuest = 0x20,
    IncrementQuest = 0x21,
    AddCharacterTitle = 0x22,
    InqBoolStat = 0x23,
    InqIntStat = 0x24,
    InqFloatStat = 0x25,
    InqStringStat = 0x26,
    InqAttributeStat = 0x27,
    InqRawAttributeStat = 0x28,
    InqSecondaryAttributeStat = 0x29,
    InqRawSecondaryAttributeStat = 0x2A,
    InqSkillStat = 0x2B,
    InqRawSkillStat = 0x2C,
    InqSkillTrained = 0x2D,
    InqSkillSpecialized = 0x2E,
    AwardTrainingCredits = 0x2F,
    InflictVitaePenalty = 0x30,
    AwardLevelProportionalXP = 0x31,
    AwardLevelProportionalSkillXP = 0x32,
    InqEvent = 0x33,
    ForceMotion = 0x34,
    SetIntStat = 0x35,
    IncrementIntStat = 0x36,
    DecrementIntStat = 0x37,
    CreateTreasure = 0x38,
    ResetHomePosition = 0x39,
    InqFellowQuest = 0x3A,
    InqFellowNum = 0x3B,
    UpdateFellowQuest = 0x3C,
    StampFellowQuest = 0x3D,
    AwardNoShareXP = 0x3E,
    SetSanctuaryPosition = 0x3F,
    TellFellow = 0x40,
    FellowBroadcast = 0x41,
    LockFellow = 0x42,
    Goto = 0x43,
    PopUp = 0x44,
    SetBoolStat = 0x45,
    SetQuestCompletions = 0x46,
    InqNumCharacterTitles = 0x47,
    Generate = 0x48,
    PetCastSpellOnOwner = 0x49,
    TakeItems = 0x4A,
    InqYesNo = 0x4B,
    InqOwnsItems = 0x4C,
    DeleteSelf = 0x4D,
    KillSelf = 0x4E,
    UpdateMyQuest = 0x4F,
    InqMyQuest = 0x50,
    StampMyQuest = 0x51,
    InqMyQuestSolves = 0x52,
    EraseMyQuest = 0x53,
    DecrementMyQuest = 0x54,
    IncrementMyQuest = 0x55,
    SetMyQuestCompletions = 0x56,
    MoveToPos = 0x57,
    LocalSignal = 0x58,
    InqPackSpace = 0x59,
    RemoveVitaePenalty = 0x5A,
    SetEyeTexture = 0x5B,
    SetEyePalette = 0x5C,
    SetNoseTexture = 0x5D,
    SetNosePalette = 0x5E,
    SetMouthTexture = 0x5F,
    SetMouthPalette = 0x60,
    SetHeadObject = 0x61,
    SetHeadPalette = 0x62,
    TeleportTarget = 0x63,
    TeleportSelf = 0x64,
    StartBarber = 0x65,
    InqQuestBitsOn = 0x66,
    InqQuestBitsOff = 0x67,
    InqMyQuestBitsOn = 0x68,
    InqMyQuestBitsOff = 0x69,
    SetQuestBitsOn = 0x6A,
    SetQuestBitsOff = 0x6B,
    SetMyQuestBitsOn = 0x6C,
    SetMyQuestBitsOff = 0x6D,
    UntrainSkill = 0x6E,
    SetAltRacialSkills = 0x6F,
    SpendLuminance = 0x70,
    AwardLuminance = 0x71,
    InqInt64Stat = 0x72,
    SetInt64Stat = 0x73,
    OpenMe = 0x74,
    CloseMe = 0x75,
    SetFloatStat = 0x76,
    AddContract = 0x77,
    RemoveContract = 0x78,
    InqContractsFull = 0x79,
}

impl EmoteType {
    /// Returns `true` for emote types that play a visible animation /
    /// produce a chat line on the local client — the subset a user-facing
    /// emote-picker panel might surface. The remainder (`InqQuest*`,
    /// `Set*Stat`, `EraseMyQuest`, etc.) are server-side script ops with
    /// no observable client effect.
    pub fn is_user_visible(&self) -> bool {
        matches!(
            self,
            EmoteType::Act
                | EmoteType::Motion
                | EmoteType::ForceMotion
                | EmoteType::Move
                | EmoteType::MoveToPos
                | EmoteType::Say
                | EmoteType::Sound
                | EmoteType::Tell
                | EmoteType::TellFellow
                | EmoteType::TextDirect
                | EmoteType::PopUp
                | EmoteType::WorldBroadcast
                | EmoteType::LocalBroadcast
                | EmoteType::DirectBroadcast
                | EmoteType::FellowBroadcast
                | EmoteType::PhysScript
                | EmoteType::CastSpell
                | EmoteType::CastSpellInstant
                | EmoteType::PetCastSpellOnOwner
                | EmoteType::AwardXP
                | EmoteType::AwardSkillXP
                | EmoteType::AwardSkillPoints
                | EmoteType::AwardLevelProportionalXP
                | EmoteType::AwardLevelProportionalSkillXP
                | EmoteType::AwardNoShareXP
                | EmoteType::SpendLuminance
                | EmoteType::AwardLuminance
                | EmoteType::AddCharacterTitle
                | EmoteType::Generate
                | EmoteType::CreateTreasure
                | EmoteType::TeleportTarget
                | EmoteType::TeleportSelf
                | EmoteType::Goto
                | EmoteType::StartBarber
                | EmoteType::TakeItems
                | EmoteType::OpenMe
                | EmoteType::CloseMe
                | EmoteType::AddContract
                | EmoteType::RemoveContract
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Asserts `EmoteCategory` integer values match
    /// `Chorizite.Common/Enums/EmoteCategory.cs:5-84`
    /// (vendored HEAD `e3b3bd2`). Spot-checks at the boundaries (0, 1, 6,
    /// 0x18, 0x26) plus the highest value (0x26).
    #[test]
    fn emote_category_values_match_chorizite() {
        assert_eq!(EmoteCategory::Invalid as u32, 0x00);
        assert_eq!(EmoteCategory::Refuse as u32, 0x01);
        assert_eq!(EmoteCategory::Vendor as u32, 0x02);
        assert_eq!(EmoteCategory::HeartBeat as u32, 0x05);
        assert_eq!(EmoteCategory::Give as u32, 0x06);
        assert_eq!(EmoteCategory::HearChat as u32, 0x18);
        assert_eq!(EmoteCategory::WoundedTaunt as u32, 0x0F);
        assert_eq!(EmoteCategory::ReceiveTalkDirect as u32, 0x26);

        // Round-trip via FromRepr
        assert_eq!(EmoteCategory::from_repr(0x06), Some(EmoteCategory::Give));
        assert_eq!(EmoteCategory::from_repr(0x26), Some(EmoteCategory::ReceiveTalkDirect));
        assert_eq!(EmoteCategory::from_repr(0x27), None);
        assert_eq!(EmoteCategory::default(), EmoteCategory::Invalid);
    }

    /// Asserts `EmoteType` integer values match
    /// `Chorizite.Common/Enums/EmoteType.cs:5-251` (vendored HEAD `e3b3bd2`).
    /// Spot-checks all the boundaries of switch cases that the wire-format
    /// `Emote::Read` cares about.
    #[test]
    fn emote_type_values_match_chorizite() {
        // Animation / chat triggers (the user-visible cluster)
        assert_eq!(EmoteType::Invalid as u32, 0x00);
        assert_eq!(EmoteType::Act as u32, 0x01);
        assert_eq!(EmoteType::AwardXP as u32, 0x02);
        assert_eq!(EmoteType::Motion as u32, 0x05);
        assert_eq!(EmoteType::Say as u32, 0x08);
        assert_eq!(EmoteType::Sound as u32, 0x09);
        assert_eq!(EmoteType::Tell as u32, 0x0A);
        assert_eq!(EmoteType::CastSpell as u32, 0x0E);

        // Quest cluster
        assert_eq!(EmoteType::UpdateQuest as u32, 0x14);
        assert_eq!(EmoteType::EraseQuest as u32, 0x1F);
        assert_eq!(EmoteType::IncrementMyQuest as u32, 0x55);

        // Stat-inspection cluster
        assert_eq!(EmoteType::InqBoolStat as u32, 0x23);
        assert_eq!(EmoteType::InqStringStat as u32, 0x26);
        assert_eq!(EmoteType::SetIntStat as u32, 0x35);
        assert_eq!(EmoteType::CreateTreasure as u32, 0x38);

        // Teleport / sanctuary cluster
        assert_eq!(EmoteType::SetSanctuaryPosition as u32, 0x3F);
        assert_eq!(EmoteType::Goto as u32, 0x43);
        assert_eq!(EmoteType::TeleportTarget as u32, 0x63);
        assert_eq!(EmoteType::TeleportSelf as u32, 0x64);

        // Quest-bits cluster
        assert_eq!(EmoteType::InqQuestBitsOn as u32, 0x66);
        assert_eq!(EmoteType::SetMyQuestBitsOff as u32, 0x6D);

        // Contracts / luminance — added late in retail.
        assert_eq!(EmoteType::SpendLuminance as u32, 0x70);
        assert_eq!(EmoteType::OpenMe as u32, 0x74);
        assert_eq!(EmoteType::AddContract as u32, 0x77);
        assert_eq!(EmoteType::InqContractsFull as u32, 0x79);

        // Round-trip via FromRepr.
        assert_eq!(EmoteType::from_repr(0x00), Some(EmoteType::Invalid));
        assert_eq!(EmoteType::from_repr(0x79), Some(EmoteType::InqContractsFull));
        assert_eq!(EmoteType::from_repr(0x7A), None);
        assert_eq!(EmoteType::default(), EmoteType::Invalid);
    }

    /// `is_user_visible` partitions the 122 emote types. We assert a few
    /// representative members from each bucket; the cluster is what drives
    /// the JS-side emote-panel filter so it's covered against accidental
    /// flipping.
    #[test]
    fn emote_type_user_visible_classification() {
        // Visible — animation, chat, FX
        assert!(EmoteType::Motion.is_user_visible());
        assert!(EmoteType::Say.is_user_visible());
        assert!(EmoteType::CastSpell.is_user_visible());
        assert!(EmoteType::PhysScript.is_user_visible());
        assert!(EmoteType::TeleportSelf.is_user_visible());
        assert!(EmoteType::AwardXP.is_user_visible());

        // Server-only — quest/stat mutators with no visible side-effect.
        assert!(!EmoteType::Invalid.is_user_visible());
        assert!(!EmoteType::InqQuest.is_user_visible());
        assert!(!EmoteType::StampQuest.is_user_visible());
        assert!(!EmoteType::SetIntStat.is_user_visible());
        assert!(!EmoteType::EraseQuest.is_user_visible());
        assert!(!EmoteType::InqBoolStat.is_user_visible());
        assert!(!EmoteType::SetSanctuaryPosition.is_user_visible());
    }

    /// `display_name` produces "Title Case With Spaces" output for every
    /// category. Spot-check a few; the exhaustive table is the match arm
    /// itself, with strum `Display` derive as the fallback for raw-id
    /// debug output.
    #[test]
    fn emote_category_display_names() {
        assert_eq!(EmoteCategory::HeartBeat.display_name(), "Heart Beat");
        assert_eq!(EmoteCategory::QuestSuccess.display_name(), "Quest Success");
        assert_eq!(
            EmoteCategory::ReceiveTalkDirect.display_name(),
            "Receive Talk Direct"
        );
        // strum derive still works for raw debug.
        assert_eq!(format!("{}", EmoteCategory::Refuse), "Refuse");
    }
}
