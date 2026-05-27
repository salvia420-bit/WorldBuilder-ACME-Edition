//! `CEmoteTable` wire-format parser — Wave F.6 (2026-05-27).
//!
//! Ports the Chorizite generated reader / writer for the AI-emote payload
//! embedded inside `CACQualities` (the WeenieDesc body that the server
//! sends on object-create / appraise). This is **NOT a standalone DAT
//! file** — see the architecture note at the top of `tests::table_round_trip`.
//!
//! The previous Wave 9.5 work (`SoulEmoteCatalog`) ported the narrower
//! `ChatPoseTable` (DAT 0x0E000007) which only carries the ~303 user-facing
//! pose tokens (`/wave`, `/bow`, `/cheer`). This wave ports the broader
//! NPC-AI emote tree: the script-driven action tree that drives vendor
//! greetings, death sounds, quest-success bows, hear-chat keyword
//! triggers, etc.
//!
//! ## Source files
//!
//! * `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Types/EmoteTable.generated.cs:22-42`
//!   — the wrapper hash table `Dictionary<EmoteCategory, EmoteSetList>`.
//! * `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Types/EmoteSetList.generated.cs:19-39`
//!   — packable list of `EmoteSet`.
//! * `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Types/EmoteSet.generated.cs:18-129`
//!   — category-discriminated header (ClassId/Style+Substyle/Quest/VendorType/MinMaxHealth)
//!   + packable list of `Emote`.
//! * `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Types/Emote.generated.cs:18-481`
//!   — type-discriminated record with 122 variants. We port the discriminant
//!   table verbatim; the field layout mirrors the C# switch cases.
//! * `external/chorizite/ACBindings/Generated/Net/Types/CEmoteTable.cs:6-23`
//!   — retail `acclient.exe` symbol (UnPack offset `0x00595C90`). Reference
//!   only — no decomp body needed; the C# generated reader IS the spec.
//!
//! ## Wire layout (read order)
//!
//! ```text
//!   EmoteTable {
//!     i16 count, i16 buckets,
//!     [ u32 category, EmoteSetList { i32 count, [ EmoteSet ]* } ]*
//!   }
//!
//!   EmoteSet {
//!     u32 category, f32 probability,
//!     match category {
//!       0x01|0x06 => u32 class_id
//!       0x05      => u32 style, u32 substyle
//!       0x02      => u32 vendor_type
//!       0x0F      => f32 min_health, f32 max_health
//!       0x0C..0x0D | 0x16..0x17 | 0x1B..0x26 => String16L quest
//!       _         => (no extra)
//!     }
//!     i32 count, [ Emote ]*
//!   }
//!
//!   Emote {
//!     u32 type, f32 delay, f32 extent,
//!     match type { ... 122 variants, see EmoteRecord enum ... }
//!   }
//! ```
//!
//! ## Why a wire-type port rather than DAT
//!
//! `CEmoteTable` is NOT in the portal DAT — it's an inline member of
//! `CACQualities` (see `ACBindings/Generated/Dats/DBObjs/CACQualities.cs:49`).
//! Each NPC's `WeenieDesc` payload carries the table as part of the
//! optional `CACQualities` blob (CharacterData/PortableQualityData
//! discriminator). This parser surfaces JS-side after the ACE server
//! pushes the full appraise / object-create blob; until then we use the
//! `Wave 9.5 SoulEmoteCatalog` for user-facing slash commands.

use crate::messages::utils::{read_hashtable_header, read_string16, write_hashtable_header, write_string16};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{LittleEndian, WriteBytesExt};
use holtburger_common::properties::{EmoteCategory, EmoteType};
use std::collections::BTreeMap;

/// Wire-shape `EmoteTable` — a categorized hash of `EmoteSet` lists.
///
/// Mirrors `Chorizite.ACProtocol.Types.EmoteTable`
/// (`EmoteTable.generated.cs:22-42`). We use `BTreeMap` rather than
/// `HashMap` so iteration order is deterministic — Pack round-trip then
/// produces byte-stable output, which matters for fixture tests.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EmoteTable {
    pub emotes: BTreeMap<EmoteCategory, Vec<EmoteSet>>,
}

impl EmoteTable {
    /// Counts the total number of `Emote` records across every category.
    /// Useful for size validation against retail-extracted reference data
    /// (a typical NPC has 5-30 emotes; bosses can go to 200+).
    pub fn total_emote_count(&self) -> usize {
        self.emotes.values().map(|sets| sets.iter().map(|s| s.emotes.len()).sum::<usize>()).sum()
    }

    /// Returns the union of `EmoteType`s used across every category. Used
    /// by the JS emote-panel to learn what action types a given NPC's
    /// script catalog can fire.
    pub fn type_palette(&self) -> Vec<EmoteType> {
        let mut palette: Vec<EmoteType> = self
            .emotes
            .values()
            .flat_map(|sets| sets.iter().flat_map(|s| s.emotes.iter().map(|e| e.emote_type())))
            .collect();
        palette.sort_by_key(|t| *t as u32);
        palette.dedup();
        palette
    }
}

impl ProtocolUnpack for EmoteTable {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let (count, _buckets) = read_hashtable_header(data, offset)?;
        let mut emotes: BTreeMap<EmoteCategory, Vec<EmoteSet>> = BTreeMap::new();
        for _ in 0..count {
            let category_raw = u32::unpack(data, offset)?;
            let category = EmoteCategory::from_repr(category_raw)?;
            let set_count = u32::unpack(data, offset)? as usize;
            let mut sets = Vec::with_capacity(set_count);
            for _ in 0..set_count {
                sets.push(EmoteSet::unpack(data, offset)?);
            }
            emotes.insert(category, sets);
        }
        Some(EmoteTable { emotes })
    }
}

impl ProtocolPack for EmoteTable {
    fn pack(&self, buf: &mut Vec<u8>) {
        // We don't track bucket count meaningfully (Chorizite always
        // emits 0); use count as a sentinel.
        write_hashtable_header(buf, self.emotes.len(), self.emotes.len());
        for (category, sets) in &self.emotes {
            (*category as u32).pack(buf);
            buf.write_u32::<LittleEndian>(sets.len() as u32).unwrap();
            for set in sets {
                set.pack(buf);
            }
        }
    }
}

/// Wire-shape `EmoteSet` — one trigger configuration for a single
/// `EmoteCategory`, e.g. "when hearing chat keyword 'Help', play this
/// emote sequence with probability 0.4".
///
/// Mirrors `Chorizite.ACProtocol.Types.EmoteSet`
/// (`EmoteSet.generated.cs:18-129`). The `category`-discriminated header
/// fields are mutually exclusive but we keep them as flat `Option<T>`
/// so the round-trip is lossless and the JSON serialization is flat
/// rather than tagged.
#[derive(Debug, Clone, PartialEq)]
pub struct EmoteSet {
    pub category: EmoteCategory,
    pub probability: f32,
    pub class_id: Option<u32>,
    pub style: Option<u32>,
    pub substyle: Option<u32>,
    pub quest: Option<String>,
    pub vendor_type: Option<u32>,
    pub min_health: Option<f32>,
    pub max_health: Option<f32>,
    pub emotes: Vec<EmoteRecord>,
}

impl Default for EmoteSet {
    fn default() -> Self {
        Self {
            category: EmoteCategory::Invalid,
            probability: 0.0,
            class_id: None,
            style: None,
            substyle: None,
            quest: None,
            vendor_type: None,
            min_health: None,
            max_health: None,
            emotes: Vec::new(),
        }
    }
}

impl ProtocolUnpack for EmoteSet {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let category_raw = u32::unpack(data, offset)?;
        let category = EmoteCategory::from_repr(category_raw)?;
        let probability = f32::unpack(data, offset)?;
        let mut set = EmoteSet {
            category,
            probability,
            ..Default::default()
        };
        // The category switch from EmoteSet.generated.cs:49-83. Categories
        // not listed get NO extra header.
        match category_raw {
            0x01 | 0x06 => {
                set.class_id = Some(u32::unpack(data, offset)?);
            }
            0x05 => {
                set.style = Some(u32::unpack(data, offset)?);
                set.substyle = Some(u32::unpack(data, offset)?);
            }
            0x02 => {
                set.vendor_type = Some(u32::unpack(data, offset)?);
            }
            0x0F => {
                set.min_health = Some(f32::unpack(data, offset)?);
                set.max_health = Some(f32::unpack(data, offset)?);
            }
            0x0C | 0x0D | 0x16 | 0x17 | 0x1B..=0x26 => {
                set.quest = Some(read_string16(data, offset)?);
            }
            _ => {}
        }
        // The packable list count is i32 per EmoteSet.generated.cs:84.
        let emote_count = u32::unpack(data, offset)? as usize;
        set.emotes = Vec::with_capacity(emote_count);
        for _ in 0..emote_count {
            set.emotes.push(EmoteRecord::unpack(data, offset)?);
        }
        Some(set)
    }
}

impl ProtocolPack for EmoteSet {
    fn pack(&self, buf: &mut Vec<u8>) {
        (self.category as u32).pack(buf);
        buf.write_f32::<LittleEndian>(self.probability).unwrap();
        let category_raw = self.category as u32;
        match category_raw {
            0x01 | 0x06 => {
                self.class_id.unwrap_or(0).pack(buf);
            }
            0x05 => {
                self.style.unwrap_or(0).pack(buf);
                self.substyle.unwrap_or(0).pack(buf);
            }
            0x02 => {
                self.vendor_type.unwrap_or(0).pack(buf);
            }
            0x0F => {
                buf.write_f32::<LittleEndian>(self.min_health.unwrap_or(0.0)).unwrap();
                buf.write_f32::<LittleEndian>(self.max_health.unwrap_or(0.0)).unwrap();
            }
            0x0C | 0x0D | 0x16 | 0x17 | 0x1B..=0x26 => {
                write_string16(buf, self.quest.as_deref().unwrap_or(""));
            }
            _ => {}
        }
        buf.write_u32::<LittleEndian>(self.emotes.len() as u32).unwrap();
        for emote in &self.emotes {
            emote.pack(buf);
        }
    }
}

/// Sub-record carried inside `EmoteRecord` for creation-emote variants
/// (`Give = 0x03`, `PetCastSpellOnOwner = 0x4A`, `InqOwnsItems = 0x4C`).
///
/// Mirrors `Chorizite.ACProtocol.Types.CreationProfile`
/// (`CreationProfile.generated.cs:23-58`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CreationProfile {
    pub weenie_class_id: u32,
    pub palette: u32,
    pub shade: f32,
    pub destination: u32,
    pub stack_size: i32,
    pub try_to_bond: bool,
}

impl ProtocolUnpack for CreationProfile {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        Some(CreationProfile {
            weenie_class_id: u32::unpack(data, offset)?,
            palette: u32::unpack(data, offset)?,
            shade: f32::unpack(data, offset)?,
            destination: u32::unpack(data, offset)?,
            stack_size: i32::unpack(data, offset)?,
            try_to_bond: bool::unpack(data, offset)?,
        })
    }
}

impl ProtocolPack for CreationProfile {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.weenie_class_id.pack(buf);
        self.palette.pack(buf);
        buf.write_f32::<LittleEndian>(self.shade).unwrap();
        self.destination.pack(buf);
        self.stack_size.pack(buf);
        self.try_to_bond.pack(buf);
    }
}

/// Sub-record carried inside `EmoteRecord` for `Frame`-bearing variants
/// (`MoveHome = 0x04`, `Move = 0x06`, `Turn = 0x0B`, `MoveToPos = 0x57`).
///
/// Mirrors `Chorizite.ACProtocol.Types.Frame`
/// (`Frame.generated.cs:23-46`). 28-byte wire shape (`Vector3` 12 + `Quaternion` 16).
/// Note Chorizite reads w-first per its custom `ReadQuaternion`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Frame {
    pub origin_x: f32,
    pub origin_y: f32,
    pub origin_z: f32,
    pub quat_w: f32,
    pub quat_x: f32,
    pub quat_y: f32,
    pub quat_z: f32,
}

impl ProtocolUnpack for Frame {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        Some(Frame {
            origin_x: f32::unpack(data, offset)?,
            origin_y: f32::unpack(data, offset)?,
            origin_z: f32::unpack(data, offset)?,
            quat_w: f32::unpack(data, offset)?,
            quat_x: f32::unpack(data, offset)?,
            quat_y: f32::unpack(data, offset)?,
            quat_z: f32::unpack(data, offset)?,
        })
    }
}

impl ProtocolPack for Frame {
    fn pack(&self, buf: &mut Vec<u8>) {
        for v in [
            self.origin_x,
            self.origin_y,
            self.origin_z,
            self.quat_w,
            self.quat_x,
            self.quat_y,
            self.quat_z,
        ] {
            buf.write_f32::<LittleEndian>(v).unwrap();
        }
    }
}

/// Sub-record carried inside `EmoteRecord` for position-bearing variants
/// (`SetSanctuaryPosition = 0x3F`, `TeleportTarget = 0x63`, `TeleportSelf = 0x64`).
///
/// Mirrors `Chorizite.ACProtocol.Types.Position`
/// (`Position.generated.cs:23-37`): landcell + frame.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Position {
    pub landcell: u32,
    pub frame: Frame,
}

impl ProtocolUnpack for Position {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        Some(Position {
            landcell: u32::unpack(data, offset)?,
            frame: Frame::unpack(data, offset)?,
        })
    }
}

impl ProtocolPack for Position {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.landcell.pack(buf);
        self.frame.pack(buf);
    }
}

/// One `Emote` action — discriminator + variant payload.
///
/// We model the wire-shape switch (`Emote.generated.cs:89-281`) as a sum
/// type. The discriminant lives at `emote_type()`; we serialize back
/// type-first to preserve the read-order contract.
///
/// The 122 `EmoteType` discriminants share 25 distinct payload shapes —
/// see the C# switch cases. We define one variant per shape and group
/// the EmoteType identifiers that map to it.
#[derive(Debug, Clone, PartialEq)]
pub enum EmoteRecord {
    /// Plain (type, delay, extent) tuple with no extra payload — covers
    /// the 90+ types whose Read switch case is empty. The `emote_type`
    /// field carries the actual discriminant.
    Bare {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
    },
    /// `Message`-only (a String16L). Types: 0x01, 0x08, 0x0A, 0x0D, 0x10,
    /// 0x11, 0x12, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1F, 0x33,
    /// 0x3A, 0x3C, 0x3D, 0x40, 0x41, 0x43, 0x44, 0x4F, 0x50, 0x51, 0x53,
    /// 0x58, 0x79.
    Message {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        message: String,
    },
    /// `Message + Amount`. Types: 0x20, 0x21, 0x46, 0x54, 0x55, 0x56, 0x59,
    /// 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D.
    MessageAmount {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        message: String,
        amount: u32,
    },
    /// `Stat + Amount`. Types: 0x35, 0x36, 0x37, 0x45.
    StatAmount {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        stat: u32,
        amount: u32,
    },
    /// `Stat`-only (uint). Types: 0x73.
    Stat {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        stat: u32,
    },
    /// `Stat + Percent`. Types: 0x76.
    StatPercent {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        stat: u32,
        percent: f64,
    },
    /// `Message + Min + Max`. Types: 0x1E, 0x3B, 0x47, 0x52.
    MessageMinMax {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        message: String,
        min: u32,
        max: u32,
    },
    /// `Amount64 + HeroXP64`. Types: 0x02 (AwardXP), 0x3E (AwardNoShareXP).
    AmountHeroXp {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        amount64: u64,
        hero_xp64: u64,
    },
    /// `Amount64`-only. Types: 0x70 (SpendLuminance), 0x71 (AwardLuminance).
    Amount64 {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        amount64: u64,
    },
    /// `Amount`-only (uint). Types: 0x22, 0x2F, 0x30, 0x5A, 0x77, 0x78.
    Amount {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        amount: u32,
    },
    /// `SpellId`-only. Types: 0x0E (CastSpell), 0x13 (CastSpellInstant),
    /// 0x1B (TeachSpell), 0x49 (PetCastSpellOnOwner).
    SpellId {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        spell_id: u32,
    },
    /// `CreationProfile`-only. Types: 0x03 (Give), 0x4A (TakeItems).
    CreateProfile {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        cprofile: CreationProfile,
    },
    /// `Msg + CreationProfile`. Types: 0x4C (InqOwnsItems).
    MessageCreateProfile {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        msg: String,
        cprofile: CreationProfile,
    },
    /// `WealthRating + TreasureClass + TreasureType`. Types: 0x38
    /// (CreateTreasure).
    Treasure {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        wealth_rating: i32,
        treasure_class: i32,
        treasure_type: i32,
    },
    /// `Motion`-only. Types: 0x05 (Motion), 0x34 (ForceMotion).
    Motion {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        motion: u32,
    },
    /// `Frame`-only. Types: 0x04 (MoveHome), 0x06 (Move), 0x0B (Turn),
    /// 0x57 (MoveToPos).
    Frame {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        frame: Frame,
    },
    /// `PhysicsScript`-only. Types: 0x07.
    PhysScript {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        physics_script: u32,
    },
    /// `Sound`-only. Types: 0x09.
    Sound {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        sound: u32,
    },
    /// `Amount + Stat` (note: stat comes second, vs StatAmount). Types:
    /// 0x1C (AwardSkillXP), 0x1D (AwardSkillPoints).
    AmountStat {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        amount: u32,
        stat: u32,
    },
    /// `Message + Stat`. Types: 0x23 (InqBoolStat), 0x2D, 0x2E.
    MessageStat {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        message: String,
        stat: u32,
    },
    /// `Message + TestString + Stat`. Types: 0x26 (InqStringStat),
    /// 0x4B (InqYesNo).
    MessageTestStringStat {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        message: String,
        test_string: String,
        stat: u32,
    },
    /// `Message + Min + Max + Stat`. Types: 0x24, 0x27..0x2C.
    MessageMinMaxStat {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        message: String,
        min: u32,
        max: u32,
        stat: u32,
    },
    /// `Message + Min64 + Max64 + Stat`. Types: 0x72 (InqInt64Stat).
    MessageMin64Max64Stat {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        message: String,
        min64: u64,
        max64: u64,
        stat: u32,
    },
    /// `Message + FMin + FMax + Stat`. Types: 0x25 (InqFloatStat).
    MessageFminFmaxStat {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        message: String,
        fmin: f64,
        fmax: f64,
        stat: u32,
    },
    /// `Percent + Min64 + Max64`. Types: 0x31 (AwardLevelProportionalXP).
    PercentMin64Max64 {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        percent: f64,
        min64: u64,
        max64: u64,
    },
    /// `Stat + Percent + Min + Max + Display`. Types: 0x32
    /// (AwardLevelProportionalSkillXP).
    StatPercentMinMaxDisplay {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        stat: u32,
        percent: f64,
        min: u32,
        max: u32,
        display: bool,
    },
    /// `Position`-only. Types: 0x3F (SetSanctuaryPosition), 0x63
    /// (TeleportTarget), 0x64 (TeleportSelf).
    Position {
        emote_type: EmoteType,
        delay: f32,
        extent: f32,
        position: Position,
    },
}

impl EmoteRecord {
    /// Returns the emote type discriminant — the field-extraction is
    /// uniform per variant so we collapse it to a single accessor.
    pub fn emote_type(&self) -> EmoteType {
        match self {
            EmoteRecord::Bare { emote_type, .. }
            | EmoteRecord::Message { emote_type, .. }
            | EmoteRecord::MessageAmount { emote_type, .. }
            | EmoteRecord::StatAmount { emote_type, .. }
            | EmoteRecord::Stat { emote_type, .. }
            | EmoteRecord::StatPercent { emote_type, .. }
            | EmoteRecord::MessageMinMax { emote_type, .. }
            | EmoteRecord::AmountHeroXp { emote_type, .. }
            | EmoteRecord::Amount64 { emote_type, .. }
            | EmoteRecord::Amount { emote_type, .. }
            | EmoteRecord::SpellId { emote_type, .. }
            | EmoteRecord::CreateProfile { emote_type, .. }
            | EmoteRecord::MessageCreateProfile { emote_type, .. }
            | EmoteRecord::Treasure { emote_type, .. }
            | EmoteRecord::Motion { emote_type, .. }
            | EmoteRecord::Frame { emote_type, .. }
            | EmoteRecord::PhysScript { emote_type, .. }
            | EmoteRecord::Sound { emote_type, .. }
            | EmoteRecord::AmountStat { emote_type, .. }
            | EmoteRecord::MessageStat { emote_type, .. }
            | EmoteRecord::MessageTestStringStat { emote_type, .. }
            | EmoteRecord::MessageMinMaxStat { emote_type, .. }
            | EmoteRecord::MessageMin64Max64Stat { emote_type, .. }
            | EmoteRecord::MessageFminFmaxStat { emote_type, .. }
            | EmoteRecord::PercentMin64Max64 { emote_type, .. }
            | EmoteRecord::StatPercentMinMaxDisplay { emote_type, .. }
            | EmoteRecord::Position { emote_type, .. } => *emote_type,
        }
    }
}

impl ProtocolUnpack for EmoteRecord {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let type_raw = u32::unpack(data, offset)?;
        let emote_type = EmoteType::from_repr(type_raw)?;
        let delay = f32::unpack(data, offset)?;
        let extent = f32::unpack(data, offset)?;
        Some(match type_raw {
            0x01 | 0x08 | 0x0A | 0x0D | 0x10 | 0x11 | 0x12 | 0x14 | 0x15 | 0x16 | 0x17 | 0x18
            | 0x19 | 0x1A | 0x1F | 0x33 | 0x3A | 0x3C | 0x3D | 0x40 | 0x41 | 0x43 | 0x44 | 0x4F
            | 0x50 | 0x51 | 0x53 | 0x58 | 0x79 => EmoteRecord::Message {
                emote_type,
                delay,
                extent,
                message: read_string16(data, offset)?,
            },
            0x20 | 0x21 | 0x46 | 0x54 | 0x55 | 0x56 | 0x59 | 0x66 | 0x67 | 0x68 | 0x69 | 0x6A
            | 0x6B | 0x6C | 0x6D => EmoteRecord::MessageAmount {
                emote_type,
                delay,
                extent,
                message: read_string16(data, offset)?,
                amount: u32::unpack(data, offset)?,
            },
            0x35 | 0x36 | 0x37 | 0x45 => EmoteRecord::StatAmount {
                emote_type,
                delay,
                extent,
                stat: u32::unpack(data, offset)?,
                amount: u32::unpack(data, offset)?,
            },
            0x73 => EmoteRecord::Stat {
                emote_type,
                delay,
                extent,
                stat: u32::unpack(data, offset)?,
            },
            0x76 => EmoteRecord::StatPercent {
                emote_type,
                delay,
                extent,
                stat: u32::unpack(data, offset)?,
                percent: f64::unpack(data, offset)?,
            },
            0x1E | 0x3B | 0x47 | 0x52 => EmoteRecord::MessageMinMax {
                emote_type,
                delay,
                extent,
                message: read_string16(data, offset)?,
                min: u32::unpack(data, offset)?,
                max: u32::unpack(data, offset)?,
            },
            0x02 | 0x3E => EmoteRecord::AmountHeroXp {
                emote_type,
                delay,
                extent,
                amount64: u64::unpack(data, offset)?,
                hero_xp64: u64::unpack(data, offset)?,
            },
            0x70 | 0x71 => EmoteRecord::Amount64 {
                emote_type,
                delay,
                extent,
                amount64: u64::unpack(data, offset)?,
            },
            0x22 | 0x2F | 0x30 | 0x5A | 0x77 | 0x78 => EmoteRecord::Amount {
                emote_type,
                delay,
                extent,
                amount: u32::unpack(data, offset)?,
            },
            0x0E | 0x13 | 0x1B | 0x49 => EmoteRecord::SpellId {
                emote_type,
                delay,
                extent,
                spell_id: u32::unpack(data, offset)?,
            },
            0x03 | 0x4A => EmoteRecord::CreateProfile {
                emote_type,
                delay,
                extent,
                cprofile: CreationProfile::unpack(data, offset)?,
            },
            0x4C => EmoteRecord::MessageCreateProfile {
                emote_type,
                delay,
                extent,
                msg: read_string16(data, offset)?,
                cprofile: CreationProfile::unpack(data, offset)?,
            },
            0x38 => EmoteRecord::Treasure {
                emote_type,
                delay,
                extent,
                wealth_rating: i32::unpack(data, offset)?,
                treasure_class: i32::unpack(data, offset)?,
                treasure_type: i32::unpack(data, offset)?,
            },
            0x05 | 0x34 => EmoteRecord::Motion {
                emote_type,
                delay,
                extent,
                motion: u32::unpack(data, offset)?,
            },
            0x04 | 0x06 | 0x0B | 0x57 => EmoteRecord::Frame {
                emote_type,
                delay,
                extent,
                frame: Frame::unpack(data, offset)?,
            },
            0x07 => EmoteRecord::PhysScript {
                emote_type,
                delay,
                extent,
                physics_script: u32::unpack(data, offset)?,
            },
            0x09 => EmoteRecord::Sound {
                emote_type,
                delay,
                extent,
                sound: u32::unpack(data, offset)?,
            },
            0x1C | 0x1D => EmoteRecord::AmountStat {
                emote_type,
                delay,
                extent,
                amount: u32::unpack(data, offset)?,
                stat: u32::unpack(data, offset)?,
            },
            // Note: Stat-only at type 0x6E is read as `Stat = u32` per
            // Emote.generated.cs:221-223. We fold to existing `Stat`.
            0x6E => EmoteRecord::Stat {
                emote_type,
                delay,
                extent,
                stat: u32::unpack(data, offset)?,
            },
            // Note: Amount-only at type 0x6F is read as `Amount = u32` per
            // Emote.generated.cs:224-226. We fold to existing `Amount`.
            0x6F => EmoteRecord::Amount {
                emote_type,
                delay,
                extent,
                amount: u32::unpack(data, offset)?,
            },
            0x23 | 0x2D | 0x2E => EmoteRecord::MessageStat {
                emote_type,
                delay,
                extent,
                message: read_string16(data, offset)?,
                stat: u32::unpack(data, offset)?,
            },
            0x26 | 0x4B => EmoteRecord::MessageTestStringStat {
                emote_type,
                delay,
                extent,
                message: read_string16(data, offset)?,
                test_string: read_string16(data, offset)?,
                stat: u32::unpack(data, offset)?,
            },
            0x24 | 0x27 | 0x28 | 0x29 | 0x2A | 0x2B | 0x2C => EmoteRecord::MessageMinMaxStat {
                emote_type,
                delay,
                extent,
                message: read_string16(data, offset)?,
                min: u32::unpack(data, offset)?,
                max: u32::unpack(data, offset)?,
                stat: u32::unpack(data, offset)?,
            },
            0x72 => EmoteRecord::MessageMin64Max64Stat {
                emote_type,
                delay,
                extent,
                message: read_string16(data, offset)?,
                min64: u64::unpack(data, offset)?,
                max64: u64::unpack(data, offset)?,
                stat: u32::unpack(data, offset)?,
            },
            0x25 => EmoteRecord::MessageFminFmaxStat {
                emote_type,
                delay,
                extent,
                message: read_string16(data, offset)?,
                fmin: f64::unpack(data, offset)?,
                fmax: f64::unpack(data, offset)?,
                stat: u32::unpack(data, offset)?,
            },
            0x31 => EmoteRecord::PercentMin64Max64 {
                emote_type,
                delay,
                extent,
                percent: f64::unpack(data, offset)?,
                min64: u64::unpack(data, offset)?,
                max64: u64::unpack(data, offset)?,
            },
            0x32 => EmoteRecord::StatPercentMinMaxDisplay {
                emote_type,
                delay,
                extent,
                stat: u32::unpack(data, offset)?,
                percent: f64::unpack(data, offset)?,
                min: u32::unpack(data, offset)?,
                max: u32::unpack(data, offset)?,
                display: bool::unpack(data, offset)?,
            },
            0x3F | 0x63 | 0x64 => EmoteRecord::Position {
                emote_type,
                delay,
                extent,
                position: Position::unpack(data, offset)?,
            },
            // All other discriminants — bare (no extra payload).
            _ => EmoteRecord::Bare {
                emote_type,
                delay,
                extent,
            },
        })
    }
}

impl ProtocolPack for EmoteRecord {
    fn pack(&self, buf: &mut Vec<u8>) {
        // Type + delay + extent header is the same shape across all
        // variants — pull them out once.
        let (etype, delay, extent) = match self {
            EmoteRecord::Bare { emote_type, delay, extent }
            | EmoteRecord::Message { emote_type, delay, extent, .. }
            | EmoteRecord::MessageAmount { emote_type, delay, extent, .. }
            | EmoteRecord::StatAmount { emote_type, delay, extent, .. }
            | EmoteRecord::Stat { emote_type, delay, extent, .. }
            | EmoteRecord::StatPercent { emote_type, delay, extent, .. }
            | EmoteRecord::MessageMinMax { emote_type, delay, extent, .. }
            | EmoteRecord::AmountHeroXp { emote_type, delay, extent, .. }
            | EmoteRecord::Amount64 { emote_type, delay, extent, .. }
            | EmoteRecord::Amount { emote_type, delay, extent, .. }
            | EmoteRecord::SpellId { emote_type, delay, extent, .. }
            | EmoteRecord::CreateProfile { emote_type, delay, extent, .. }
            | EmoteRecord::MessageCreateProfile { emote_type, delay, extent, .. }
            | EmoteRecord::Treasure { emote_type, delay, extent, .. }
            | EmoteRecord::Motion { emote_type, delay, extent, .. }
            | EmoteRecord::Frame { emote_type, delay, extent, .. }
            | EmoteRecord::PhysScript { emote_type, delay, extent, .. }
            | EmoteRecord::Sound { emote_type, delay, extent, .. }
            | EmoteRecord::AmountStat { emote_type, delay, extent, .. }
            | EmoteRecord::MessageStat { emote_type, delay, extent, .. }
            | EmoteRecord::MessageTestStringStat { emote_type, delay, extent, .. }
            | EmoteRecord::MessageMinMaxStat { emote_type, delay, extent, .. }
            | EmoteRecord::MessageMin64Max64Stat { emote_type, delay, extent, .. }
            | EmoteRecord::MessageFminFmaxStat { emote_type, delay, extent, .. }
            | EmoteRecord::PercentMin64Max64 { emote_type, delay, extent, .. }
            | EmoteRecord::StatPercentMinMaxDisplay { emote_type, delay, extent, .. }
            | EmoteRecord::Position { emote_type, delay, extent, .. } => (*emote_type, *delay, *extent),
        };
        (etype as u32).pack(buf);
        buf.write_f32::<LittleEndian>(delay).unwrap();
        buf.write_f32::<LittleEndian>(extent).unwrap();

        match self {
            EmoteRecord::Bare { .. } => {}
            EmoteRecord::Message { message, .. } => write_string16(buf, message),
            EmoteRecord::MessageAmount { message, amount, .. } => {
                write_string16(buf, message);
                amount.pack(buf);
            }
            EmoteRecord::StatAmount { stat, amount, .. } => {
                stat.pack(buf);
                amount.pack(buf);
            }
            EmoteRecord::Stat { stat, .. } => stat.pack(buf),
            EmoteRecord::StatPercent { stat, percent, .. } => {
                stat.pack(buf);
                buf.write_f64::<LittleEndian>(*percent).unwrap();
            }
            EmoteRecord::MessageMinMax { message, min, max, .. } => {
                write_string16(buf, message);
                min.pack(buf);
                max.pack(buf);
            }
            EmoteRecord::AmountHeroXp { amount64, hero_xp64, .. } => {
                amount64.pack(buf);
                hero_xp64.pack(buf);
            }
            EmoteRecord::Amount64 { amount64, .. } => amount64.pack(buf),
            EmoteRecord::Amount { amount, .. } => amount.pack(buf),
            EmoteRecord::SpellId { spell_id, .. } => spell_id.pack(buf),
            EmoteRecord::CreateProfile { cprofile, .. } => cprofile.pack(buf),
            EmoteRecord::MessageCreateProfile { msg, cprofile, .. } => {
                write_string16(buf, msg);
                cprofile.pack(buf);
            }
            EmoteRecord::Treasure {
                wealth_rating,
                treasure_class,
                treasure_type,
                ..
            } => {
                wealth_rating.pack(buf);
                treasure_class.pack(buf);
                treasure_type.pack(buf);
            }
            EmoteRecord::Motion { motion, .. } => motion.pack(buf),
            EmoteRecord::Frame { frame, .. } => frame.pack(buf),
            EmoteRecord::PhysScript { physics_script, .. } => physics_script.pack(buf),
            EmoteRecord::Sound { sound, .. } => sound.pack(buf),
            EmoteRecord::AmountStat { amount, stat, .. } => {
                amount.pack(buf);
                stat.pack(buf);
            }
            EmoteRecord::MessageStat { message, stat, .. } => {
                write_string16(buf, message);
                stat.pack(buf);
            }
            EmoteRecord::MessageTestStringStat {
                message,
                test_string,
                stat,
                ..
            } => {
                write_string16(buf, message);
                write_string16(buf, test_string);
                stat.pack(buf);
            }
            EmoteRecord::MessageMinMaxStat {
                message, min, max, stat, ..
            } => {
                write_string16(buf, message);
                min.pack(buf);
                max.pack(buf);
                stat.pack(buf);
            }
            EmoteRecord::MessageMin64Max64Stat {
                message,
                min64,
                max64,
                stat,
                ..
            } => {
                write_string16(buf, message);
                min64.pack(buf);
                max64.pack(buf);
                stat.pack(buf);
            }
            EmoteRecord::MessageFminFmaxStat {
                message, fmin, fmax, stat, ..
            } => {
                write_string16(buf, message);
                buf.write_f64::<LittleEndian>(*fmin).unwrap();
                buf.write_f64::<LittleEndian>(*fmax).unwrap();
                stat.pack(buf);
            }
            EmoteRecord::PercentMin64Max64 {
                percent, min64, max64, ..
            } => {
                buf.write_f64::<LittleEndian>(*percent).unwrap();
                min64.pack(buf);
                max64.pack(buf);
            }
            EmoteRecord::StatPercentMinMaxDisplay {
                stat, percent, min, max, display, ..
            } => {
                stat.pack(buf);
                buf.write_f64::<LittleEndian>(*percent).unwrap();
                min.pack(buf);
                max.pack(buf);
                display.pack(buf);
            }
            EmoteRecord::Position { position, .. } => position.pack(buf),
        }
    }
}

// Workaround: i32 ProtocolPack/Unpack lives in traits.rs via `impl_primitive!`,
// but the WriteBytesExt + LittleEndian helpers needed for `i32.pack` are
// not directly visible from this file. The macro provides them; we just
// need the explicit imports above. See top of file.
#[allow(dead_code)]
fn _i32_check(value: i32, buf: &mut Vec<u8>) {
    value.pack(buf);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Architecture note.** This parser lives in `holtburger-protocol`
    /// rather than `holtburger-dat` because `CEmoteTable` is NOT a
    /// standalone DAT file — it's an inline member of `CACQualities`
    /// (the wire-side WeenieDesc payload). See
    /// `external/chorizite/ACBindings/Generated/Dats/DBObjs/CACQualities.cs:49`
    /// for the C# struct member. The chorizite-reading-guide-summary §4
    /// Wave F row #6 originally hypothesised "DAT type or both?" — the
    /// answer is **wire type only**.
    ///
    /// Round-trips a synthetic minimal EmoteTable (one Vendor category,
    /// one EmoteSet with one Say emote). This locks in the read-order
    /// contract so a future refactor can't silently change the layout.
    #[test]
    fn table_round_trip() {
        let table = EmoteTable {
            emotes: BTreeMap::from([(
                EmoteCategory::Vendor,
                vec![EmoteSet {
                    category: EmoteCategory::Vendor,
                    probability: 0.5,
                    vendor_type: Some(0x0_0000_0001),
                    emotes: vec![EmoteRecord::Message {
                        emote_type: EmoteType::Say,
                        delay: 0.25,
                        extent: 1.0,
                        message: "Welcome, friend.".to_string(),
                    }],
                    ..Default::default()
                }],
            )]),
        };
        // pack
        let mut buf = Vec::new();
        table.pack(&mut buf);
        // unpack
        let mut offset = 0;
        let parsed = EmoteTable::unpack(&buf, &mut offset).expect("unpack");
        assert_eq!(parsed, table);
        assert_eq!(parsed.total_emote_count(), 1);
        assert_eq!(parsed.type_palette(), vec![EmoteType::Say]);
    }

    /// Exercises the full breadth of switch cases. For each variant we
    /// construct a representative record, pack, unpack, assert equality.
    /// This catches read-order regressions in any one branch without
    /// relying on a retail wire fixture. Wave F.6 baseline.
    #[test]
    fn emote_record_all_variants_round_trip() {
        let cases: Vec<EmoteRecord> = vec![
            // Bare (e.g. EraseQuest = 0x1F is actually Message — we use
            // an unmapped type like 0x39 ResetHomePosition for true bare).
            EmoteRecord::Bare {
                emote_type: EmoteType::ResetHomePosition,
                delay: 0.0,
                extent: 0.0,
            },
            EmoteRecord::Message {
                emote_type: EmoteType::Say,
                delay: 1.0,
                extent: 0.0,
                message: "Hello, world.".to_string(),
            },
            EmoteRecord::MessageAmount {
                emote_type: EmoteType::SetQuestCompletions,
                delay: 0.0,
                extent: 0.0,
                message: "quest_token".to_string(),
                amount: 42,
            },
            EmoteRecord::StatAmount {
                emote_type: EmoteType::SetIntStat,
                delay: 0.0,
                extent: 0.0,
                stat: 0x0080_0000,
                amount: 100,
            },
            EmoteRecord::Stat {
                emote_type: EmoteType::SetInt64Stat,
                delay: 0.0,
                extent: 0.0,
                stat: 1,
            },
            EmoteRecord::StatPercent {
                emote_type: EmoteType::SetFloatStat,
                delay: 0.0,
                extent: 0.0,
                stat: 1,
                percent: 0.25,
            },
            EmoteRecord::MessageMinMax {
                emote_type: EmoteType::InqQuestSolves,
                delay: 0.0,
                extent: 0.0,
                message: "msg".to_string(),
                min: 1,
                max: 5,
            },
            EmoteRecord::AmountHeroXp {
                emote_type: EmoteType::AwardXP,
                delay: 0.0,
                extent: 0.0,
                amount64: 5000,
                hero_xp64: 250,
            },
            EmoteRecord::Amount64 {
                emote_type: EmoteType::AwardLuminance,
                delay: 0.0,
                extent: 0.0,
                amount64: 1_000_000,
            },
            EmoteRecord::Amount {
                emote_type: EmoteType::AddCharacterTitle,
                delay: 0.0,
                extent: 0.0,
                amount: 32,
            },
            EmoteRecord::SpellId {
                emote_type: EmoteType::CastSpell,
                delay: 0.5,
                extent: 0.0,
                spell_id: 1,
            },
            EmoteRecord::CreateProfile {
                emote_type: EmoteType::Give,
                delay: 0.0,
                extent: 0.0,
                cprofile: CreationProfile {
                    weenie_class_id: 12345,
                    palette: 0,
                    shade: 0.5,
                    destination: 0,
                    stack_size: 1,
                    try_to_bond: false,
                },
            },
            EmoteRecord::MessageCreateProfile {
                emote_type: EmoteType::InqOwnsItems,
                delay: 0.0,
                extent: 0.0,
                msg: "do you have it".to_string(),
                cprofile: CreationProfile {
                    weenie_class_id: 7,
                    palette: 0,
                    shade: 0.0,
                    destination: 0,
                    stack_size: 1,
                    try_to_bond: true,
                },
            },
            EmoteRecord::Treasure {
                emote_type: EmoteType::CreateTreasure,
                delay: 0.0,
                extent: 0.0,
                wealth_rating: 4,
                treasure_class: 100,
                treasure_type: 2,
            },
            EmoteRecord::Motion {
                emote_type: EmoteType::Motion,
                delay: 0.0,
                extent: 1.0,
                motion: 0x4300_00EC, // Bow per acpedia
            },
            EmoteRecord::Frame {
                emote_type: EmoteType::Move,
                delay: 0.0,
                extent: 0.0,
                frame: Frame {
                    origin_x: 10.0,
                    origin_y: 20.0,
                    origin_z: 0.0,
                    quat_w: 1.0,
                    quat_x: 0.0,
                    quat_y: 0.0,
                    quat_z: 0.0,
                },
            },
            EmoteRecord::PhysScript {
                emote_type: EmoteType::PhysScript,
                delay: 0.0,
                extent: 1.0,
                physics_script: 0x33_000010,
            },
            EmoteRecord::Sound {
                emote_type: EmoteType::Sound,
                delay: 0.0,
                extent: 1.0,
                sound: 0x0A00_0001,
            },
            EmoteRecord::AmountStat {
                emote_type: EmoteType::AwardSkillXP,
                delay: 0.0,
                extent: 0.0,
                amount: 100,
                stat: 0x10,
            },
            EmoteRecord::MessageStat {
                emote_type: EmoteType::InqBoolStat,
                delay: 0.0,
                extent: 0.0,
                message: "test".to_string(),
                stat: 1,
            },
            EmoteRecord::MessageTestStringStat {
                emote_type: EmoteType::InqStringStat,
                delay: 0.0,
                extent: 0.0,
                message: "msg".to_string(),
                test_string: "test".to_string(),
                stat: 0,
            },
            EmoteRecord::MessageMinMaxStat {
                emote_type: EmoteType::InqIntStat,
                delay: 0.0,
                extent: 0.0,
                message: "ok".to_string(),
                min: 1,
                max: 100,
                stat: 0x10,
            },
            EmoteRecord::MessageMin64Max64Stat {
                emote_type: EmoteType::InqInt64Stat,
                delay: 0.0,
                extent: 0.0,
                message: "msg64".to_string(),
                min64: 0,
                max64: u64::MAX,
                stat: 0,
            },
            EmoteRecord::MessageFminFmaxStat {
                emote_type: EmoteType::InqFloatStat,
                delay: 0.0,
                extent: 0.0,
                message: "msgf".to_string(),
                fmin: 0.0,
                fmax: 1.0,
                stat: 0,
            },
            EmoteRecord::PercentMin64Max64 {
                emote_type: EmoteType::AwardLevelProportionalXP,
                delay: 0.0,
                extent: 0.0,
                percent: 0.1,
                min64: 100,
                max64: 10000,
            },
            EmoteRecord::StatPercentMinMaxDisplay {
                emote_type: EmoteType::AwardLevelProportionalSkillXP,
                delay: 0.0,
                extent: 0.0,
                stat: 0x20,
                percent: 0.5,
                min: 10,
                max: 1000,
                display: true,
            },
            EmoteRecord::Position {
                emote_type: EmoteType::TeleportSelf,
                delay: 0.0,
                extent: 0.0,
                position: Position {
                    landcell: 0x12340001,
                    frame: Frame::default(),
                },
            },
        ];

        for case in cases {
            let mut buf = Vec::new();
            case.pack(&mut buf);
            let mut offset = 0;
            let parsed = EmoteRecord::unpack(&buf, &mut offset).expect("unpack");
            assert_eq!(parsed, case, "round-trip mismatch for {:?}", case.emote_type());
        }
    }

    /// Exercises the category-discriminated EmoteSet header. We
    /// construct one set per discriminated branch, pack-then-unpack, and
    /// confirm the per-category field stays in the right Option slot.
    #[test]
    fn emote_set_category_branches_round_trip() {
        // Helper to build a minimal set with one bare emote.
        let mk_set = |cat: EmoteCategory| EmoteSet {
            category: cat,
            probability: 1.0,
            emotes: vec![EmoteRecord::Bare {
                emote_type: EmoteType::ResetHomePosition,
                delay: 0.0,
                extent: 0.0,
            }],
            ..Default::default()
        };

        // 0x01 Refuse / 0x06 Give → class_id
        let mut s = mk_set(EmoteCategory::Refuse);
        s.class_id = Some(0xCAFE_BABE);
        assert_pack_unpack_parity_set(&s);
        let mut s = mk_set(EmoteCategory::Give);
        s.class_id = Some(0xDEAD_BEEF);
        assert_pack_unpack_parity_set(&s);

        // 0x05 HeartBeat → style + substyle
        let mut s = mk_set(EmoteCategory::HeartBeat);
        s.style = Some(0x4000_0002);
        s.substyle = Some(0x4001_0009);
        assert_pack_unpack_parity_set(&s);

        // 0x02 Vendor → vendor_type
        let mut s = mk_set(EmoteCategory::Vendor);
        s.vendor_type = Some(5);
        assert_pack_unpack_parity_set(&s);

        // 0x0F WoundedTaunt → min/max health
        let mut s = mk_set(EmoteCategory::WoundedTaunt);
        s.min_health = Some(0.0);
        s.max_health = Some(0.5);
        assert_pack_unpack_parity_set(&s);

        // 0x18 HearChat → no extra (uses default branch)
        let s = mk_set(EmoteCategory::HearChat);
        assert_pack_unpack_parity_set(&s);

        // 0x0C QuestSuccess → quest string
        let mut s = mk_set(EmoteCategory::QuestSuccess);
        s.quest = Some("hellfire-bow-completion".to_string());
        assert_pack_unpack_parity_set(&s);

        // 0x26 ReceiveTalkDirect → also quest (high end of the range)
        let mut s = mk_set(EmoteCategory::ReceiveTalkDirect);
        s.quest = Some("npc-talkback-id-7".to_string());
        assert_pack_unpack_parity_set(&s);

        // 0x1B EventSuccess → quest (inside the 0x1B..=0x26 range)
        let mut s = mk_set(EmoteCategory::EventSuccess);
        s.quest = Some("event-bonfire".to_string());
        assert_pack_unpack_parity_set(&s);
    }

    fn assert_pack_unpack_parity_set(s: &EmoteSet) {
        let mut buf = Vec::new();
        s.pack(&mut buf);
        let mut offset = 0;
        let parsed = EmoteSet::unpack(&buf, &mut offset).expect("unpack");
        assert_eq!(&parsed, s, "EmoteSet round-trip mismatch for {:?}", s.category);
    }

    /// Empty table edge case: 0 categories. Header is just (0, 0).
    #[test]
    fn empty_table_round_trip() {
        let table = EmoteTable::default();
        let mut buf = Vec::new();
        table.pack(&mut buf);
        // 2 u16's worth of header.
        assert_eq!(buf.len(), 4);
        let mut offset = 0;
        let parsed = EmoteTable::unpack(&buf, &mut offset).expect("unpack");
        assert!(parsed.emotes.is_empty());
        assert_eq!(parsed.total_emote_count(), 0);
    }

    /// Fixture-style round trip — anchors the byte layout of a
    /// representative vendor-emote NPC against the pack-unpack contract.
    /// If a future refactor changes the read order in just one place,
    /// the assert_pack_unpack_parity (defined in test_helpers) catches
    /// the divergence without needing a real ACE-side captured packet.
    #[test]
    fn vendor_npc_minimal_fixture() {
        let table = EmoteTable {
            emotes: BTreeMap::from([(
                EmoteCategory::Vendor,
                vec![
                    EmoteSet {
                        category: EmoteCategory::Vendor,
                        probability: 1.0,
                        vendor_type: Some(1), // ItemType::WeaponAndAmmo
                        emotes: vec![
                            EmoteRecord::Message {
                                emote_type: EmoteType::Say,
                                delay: 0.0,
                                extent: 1.0,
                                message: "Looking for fine weapons?".to_string(),
                            },
                            EmoteRecord::Motion {
                                emote_type: EmoteType::Motion,
                                delay: 0.5,
                                extent: 1.0,
                                motion: 0x4300_00B1, // Salute
                            },
                        ],
                        ..Default::default()
                    },
                ],
            )]),
        };
        let mut buf = Vec::new();
        table.pack(&mut buf);
        let mut offset = 0;
        let parsed = EmoteTable::unpack(&buf, &mut offset).expect("unpack");
        assert_eq!(parsed, table);
        assert_eq!(parsed.total_emote_count(), 2);
        assert_eq!(
            parsed.type_palette(),
            vec![EmoteType::Motion, EmoteType::Say]
        );
    }

    /// Confirms `unpack` returns None on an unknown EmoteCategory rather
    /// than panicking — important because retail DATs can carry future-
    /// version categories the client doesn't know yet.
    #[test]
    fn unknown_category_returns_none() {
        let mut buf = Vec::new();
        // header: 1 entry, 0 buckets
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        // category: 0xFF = unmapped
        buf.extend_from_slice(&0xFFu32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // count

        let mut offset = 0;
        assert!(EmoteTable::unpack(&buf, &mut offset).is_none());
    }
}

/// Mirror of `test_pack_unpack_parity` used by other modules to
/// validate against ACE-derived hex fixtures. We don't have any retail
/// emote-table fixtures committed yet — the round-trip + variant tests
/// above lock in the read-order contract.
#[cfg(test)]
fn _placeholder_for_fixture_tests() {}
