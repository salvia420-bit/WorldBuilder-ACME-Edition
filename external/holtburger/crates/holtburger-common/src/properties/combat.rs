use bitflags::bitflags;
use serde::{Deserialize, Serialize};
use strum_macros::{Display, FromRepr};

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
    pub struct ImbuedEffectType: u32 {
        const Undef                           = 0;
        const CriticalStrike                  = 0x0001;
        const CripplingBlow                   = 0x0002;
        const ArmorRending                    = 0x0004;
        const SlashRending                    = 0x0008;
        const PierceRending                   = 0x0010;
        const BludgeonRending                 = 0x0020;
        const AcidRending                     = 0x0040;
        const ColdRending                     = 0x0080;
        const ElectricRending                 = 0x0100;
        const FireRending                     = 0x0200;
        const MeleeDefense                    = 0x0400;
        const MissileDefense                  = 0x0800;
        const MagicDefense                    = 0x1000;
        const Spellbook                       = 0x2000;
        const NetherRending                   = 0x4000;
        const IgnoreSomeMagicProjectileDamage = 0x20000000;
        const AlwaysCritical                  = 0x40000000;
        const IgnoreAllArmor                  = 0x80000000;
    }
}

impl ImbuedEffectType {
    pub fn iter_display_names(&self) -> impl Iterator<Item = &'static str> {
        self.iter_names().map(|(name, _)| match name {
            "CriticalStrike" => "Critical Strike",
            "CripplingBlow" => "Crippling Blow",
            "ArmorRending" => "Armor Rending",
            "SlashRending" => "Slash Rending",
            "PierceRending" => "Pierce Rending",
            "BludgeonRending" => "Bludgeon Rending",
            "AcidRending" => "Acid Rending",
            "ColdRending" => "Cold Rending",
            "ElectricRending" => "Electric Rending",
            "FireRending" => "Fire Rending",
            "MeleeDefense" => "+1 Melee Defense",
            "MissileDefense" => "+1 Missile Defense",
            "MagicDefense" => "+1 Magic Defense",
            "NetherRending" => "Nether Rending",
            "IgnoreSomeMagicProjectileDamage" => "Ignore Some Magic Projectile Damage",
            "AlwaysCritical" => "Always Critical",
            "IgnoreAllArmor" => "Ignore All Armor",
            _ => name,
        })
    }
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default)]
    pub struct DamageType: u32 {
        const UNDEF       = 0x0;
        const SLASH       = 0x1;
        const PIERCE      = 0x2;
        const BLUDGEON    = 0x4;
        const COLD        = 0x8;
        const FIRE        = 0x10;
        const ACID        = 0x20;
        const ELECTRIC    = 0x40;
        const HEALTH      = 0x80;
        const STAMINA     = 0x100;
        const MANA        = 0x200;
        const NETHER      = 0x400;
        const BASE        = 0x10000000;

        const PHYSICAL    = Self::SLASH.bits() | Self::PIERCE.bits() | Self::BLUDGEON.bits();
        const ELEMENTAL   = Self::COLD.bits() | Self::FIRE.bits() | Self::ACID.bits() | Self::ELECTRIC.bits();
    }
}

impl DamageType {
    pub fn iter_display_names(&self) -> impl Iterator<Item = &'static str> {
        self.iter_names().map(|(name, _)| match name {
            "SLASH" => "Slashing",
            "PIERCE" => "Piercing",
            "BLUDGEON" => "Bludgeoning",
            "COLD" => "Cold",
            "FIRE" => "Fire",
            "ACID" => "Acid",
            "ELECTRIC" => "Electric",
            "HEALTH" => "Health",
            "STAMINA" => "Stamina",
            "MANA" => "Mana",
            "NETHER" => "Nether",
            "BASE" => "Base",
            _ => name,
        })
    }
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
    pub struct EnchantmentTypeFlags: u32 {
        const UNDEF                  = 0x0000000;
        const ATTRIBUTE              = 0x0000001;
        const SECOND_ATT             = 0x0000002;
        const INT                    = 0x0000004;
        const FLOAT                  = 0x0000008;
        const SKILL                  = 0x0000010;
        const BODY_DAMAGE_VALUE      = 0x0000020;
        const BODY_DAMAGE_VARIANCE   = 0x0000040;
        const BODY_ARMOR_VALUE       = 0x0000080;
        const SINGLE_STAT            = 0x0001000;
        const MULTIPLE_STAT          = 0x0002000;
        const MULTIPLICATIVE         = 0x0004000;
        const ADDITIVE               = 0x0008000;
        const ATTACK_SKILLS          = 0x0010000;
        const DEFENSE_SKILLS         = 0x0020000;
        const MULTIPLICATIVE_DEGRADE = 0x0100000;
        const ADDITIVE_DEGRADE       = 0x0200000;
        const VITAE                  = 0x0800000;
        const COOLDOWN               = 0x1000000;
        const BENEFICIAL             = 0x2000000;
        const STAT_TYPES             = 0x00000FF;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromRepr, Display, Serialize, Deserialize, Default)]
#[repr(u8)]
pub enum CombatUse {
    #[default]
    None = 0,
    Melee = 1,
    Missile = 2,
    Ammo = 3,
    Shield = 4,
    TwoHanded = 5,
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
    pub struct AttackType: u32 {
        const Undef               = 0;
        const Punch               = 0x0001;
        const Thrust              = 0x0002;
        const Slash               = 0x0004;
        const Kick                = 0x0008;
        const OffhandPunch        = 0x0010;
        const DoubleSlash         = 0x0020;
        const TripleSlash         = 0x0040;
        const DoubleThrust        = 0x0080;
        const TripleThrust        = 0x0100;
        const OffhandThrust       = 0x0200;
        const OffhandSlash        = 0x0400;
        const OffhandDoubleSlash  = 0x0800;
        const OffhandTripleSlash  = 0x1000;
        const OffhandDoubleThrust = 0x2000;
        const OffhandTripleThrust = 0x4000;

        const Unarmed             = Self::Punch.bits() | Self::Kick.bits() | Self::OffhandPunch.bits();

        const DoubleStrike        = Self::DoubleSlash.bits() | Self::DoubleThrust.bits() | Self::OffhandDoubleSlash.bits() | Self::OffhandDoubleThrust.bits();
        const TripleStrike        = Self::TripleSlash.bits() | Self::TripleThrust.bits() | Self::OffhandTripleSlash.bits() | Self::OffhandTripleThrust.bits();

        const Offhand             = Self::OffhandThrust.bits() | Self::OffhandSlash.bits() | Self::OffhandDoubleSlash.bits() | Self::OffhandTripleSlash.bits() | Self::OffhandDoubleThrust.bits() | Self::OffhandTripleThrust.bits();
        const Thrusts             = Self::Thrust.bits() | Self::DoubleThrust.bits() | Self::TripleThrust.bits() | Self::OffhandThrust.bits() | Self::OffhandDoubleThrust.bits() | Self::OffhandTripleThrust.bits();
        const Slashes             = Self::Slash.bits() | Self::DoubleSlash.bits() | Self::TripleSlash.bits() | Self::OffhandSlash.bits() | Self::OffhandDoubleSlash.bits() | Self::OffhandTripleSlash.bits();
        const Punches             = Self::Punch.bits() | Self::OffhandPunch.bits();

        const MultiStrike         = Self::DoubleStrike.bits() | Self::TripleStrike.bits();
    }
}

impl AttackType {
    pub fn iter_display_names(&self) -> impl Iterator<Item = &'static str> {
        self.iter_names().map(|(name, _)| match name {
            "OffhandPunch" => "Offhand Punch",
            "DoubleSlash" => "Double Slash",
            "TripleSlash" => "Triple Slash",
            "DoubleThrust" => "Double Thrust",
            "TripleThrust" => "Triple Thrust",
            "OffhandThrust" => "Offhand Thrust",
            "OffhandSlash" => "Offhand Slash",
            "OffhandDoubleSlash" => "Offhand Double Slash",
            "OffhandTripleSlash" => "Offhand Triple Slash",
            "OffhandDoubleThrust" => "Offhand Double Thrust",
            "OffhandTripleThrust" => "Offhand Triple Thrust",
            _ => name,
        })
    }
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    FromRepr,
    Display,
    Serialize,
    Deserialize,
    Default,
)]
#[repr(u32)]
pub enum WeaponType {
    #[default]
    Undef = 0,
    Unarmed = 1,
    Sword = 2,
    Axe = 3,
    Mace = 4,
    Spear = 5,
    Dagger = 6,
    Staff = 7,
    Bow = 8,
    Crossbow = 9,
    Thrown = 10,
    #[strum(serialize = "Two-Handed")]
    TwoHanded = 11,
    Magic = 12,
}

/// Spell categorization (war/life/item/creature/void + heritage).
/// Mirrors `Chorizite.Common.Enums.SpellType`
/// (`Chorizite.Common/Enums/SpellType.cs:7-24`, vendored HEAD `e3b3bd2`).
///
/// The C# enum has no explicit discriminants — values follow `None = 0`
/// declaration order, 16 variants total (`None = 0` ... `EnchantmentProjectile = 15`).
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    Display,
    FromRepr,
    Default,
)]
#[repr(u32)]
pub enum SpellType {
    #[default]
    None = 0,
    Enchantment = 1,
    Projectile = 2,
    Boost = 3,
    Transfer = 4,
    PortalLink = 5,
    PortalRecall = 6,
    PortalSummon = 7,
    PortalSending = 8,
    Dispel = 9,
    LifeProjectile = 10,
    FellowBoost = 11,
    FellowEnchantment = 12,
    FellowPortalSending = 13,
    FellowDispel = 14,
    EnchantmentProjectile = 15,
}

bitflags! {
    /// Spell metadata flags. Mirrors `Chorizite.Common.Enums.SpellFlags`
    /// (`Chorizite.Common/Enums/SpellFlags.cs:7-26`, vendored HEAD `e3b3bd2`).
    ///
    /// `[Flags]` bitmask used by `Chorizite.Common.SpellComponent` decisions
    /// and by holtburger spell research / spellbook plugins.
    ///
    /// Per the Chorizite.Common READING_GUIDE §6 idiom mapping, our crate uses
    /// `SCREAMING_SNAKE_CASE` const names but the integer values match
    /// Chorizite exactly. Note: the C# source has `UNKNOWN = 0x20000`
    /// preserved verbatim (Chorizite-team uncertainty about this bit's
    /// semantics, not a sentinel).
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default)]
    pub struct SpellFlags: u32 {
        const RESISTABLE                       = 0x00000001;
        const PK_SENSITIVE                     = 0x00000002;
        const BENEFICIAL                       = 0x00000004;
        const SELF_TARGETED                    = 0x00000008;
        const REVERSED                         = 0x00000010;
        const NOT_INDOOR                       = 0x00000020;
        const NOT_OUTDOOR                      = 0x00000040;
        const NOT_RESEARCHABLE                 = 0x00000080;
        const PROJECTILE                       = 0x00000100;
        const CREATURE_SPELL                   = 0x00000200;
        const EXCLUDED_FROM_ITEM_DESCRIPTIONS  = 0x00000400;
        const IGNORES_MANA_CONVERSION          = 0x00000800;
        const NON_TRACKING_PROJECTILE          = 0x00001000;
        const FELLOWSHIP_SPELL                 = 0x00002000;
        const FAST_CAST                        = 0x00004000;
        const INDOOR_LONG_RANGE                = 0x00008000;
        const DAMAGE_OVER_TIME                 = 0x00010000;
        const UNKNOWN                          = 0x00020000;
    }
}

/// Spell component category (scarab/herb/talisman/etc.). Mirrors
/// `Chorizite.Common.Enums.SpellComponentType`
/// (`Chorizite.Common/Enums/SpellComponentType.cs:9-20`, vendored HEAD `e3b3bd2`).
///
/// The C# source contains **duplicate discriminants** (`TalismanPea = 5u`
/// aliases `Talisman = 5u`; `TaperPea = 7u` aliases `Taper = 7u`; and —
/// strangest of all — `PotionPea = 7u` ALIASES `Taper = 7u` not `Potion = 4u`).
/// Rust enums forbid duplicate discriminants, so we expose the primary
/// variants as enum members and the `*Pea` aliases as associated constants.
/// **Upstream-bug candidate:** the `PotionPea = 7u` value almost certainly
/// should be `PotionPea = 4u` to alias `Potion`; flag for upstream PR.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    Display,
    FromRepr,
    Default,
)]
#[repr(u32)]
pub enum SpellComponentType {
    #[default]
    Undef = 0,
    Scarab = 1,
    Herb = 2,
    Powder = 3,
    Potion = 4,
    Talisman = 5,
    Taper = 6,
    PotionPea = 7,
}

impl SpellComponentType {
    /// Alias for `Talisman` (Chorizite C#: `TalismanPea = 5u`).
    pub const TALISMAN_PEA: SpellComponentType = SpellComponentType::Talisman;
    /// Alias for `PotionPea = 7` (Chorizite C#: `TaperPea = 7u`).
    ///
    /// **Note:** the Chorizite source defines `Taper = 6u` AND
    /// `TaperPea = 7u`, so `TaperPea` does NOT alias `Taper`. It collides
    /// with `PotionPea`. Likely a copy-paste error in the C# source.
    pub const TAPER_PEA: SpellComponentType = SpellComponentType::PotionPea;
}

bitflags! {
    /// Spell-school filter bitmask. Mirrors
    /// `Chorizite.Common.Enums.SpellBookFilterOptions`
    /// (`Chorizite.Common/Enums/SpellBookFilterOptions.cs:8-39`, vendored HEAD `e3b3bd2`).
    ///
    /// `[Flags]` bitmask used by the Phase H spellbook filter UI to gate
    /// displayed spells by school (Creature/Item/Life/War/Void) and level (1-9).
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default)]
    pub struct SpellBookFilterOptions: u32 {
        const NONE     = 0x00000000;
        const CREATURE = 0x00000001;
        const ITEM     = 0x00000002;
        const LIFE     = 0x00000004;
        const WAR      = 0x00000008;
        const LEVEL_1  = 0x00000010;
        const LEVEL_2  = 0x00000020;
        const LEVEL_3  = 0x00000040;
        const LEVEL_4  = 0x00000080;
        const LEVEL_5  = 0x00000100;
        const LEVEL_6  = 0x00000200;
        const LEVEL_7  = 0x00000400;
        const LEVEL_8  = 0x00000800;
        const LEVEL_9  = 0x00001000;
        const VOID     = 0x00002000;
    }
}

#[cfg(test)]
mod spell_enum_tests {
    use super::*;

    /// Asserts `SpellType` integer values match
    /// `Chorizite.Common/Enums/SpellType.cs:7-24`
    /// (vendored HEAD `e3b3bd2`).
    #[test]
    fn spell_type_values_match_chorizite() {
        assert_eq!(SpellType::None as u32, 0);
        assert_eq!(SpellType::Enchantment as u32, 1);
        assert_eq!(SpellType::Projectile as u32, 2);
        assert_eq!(SpellType::Boost as u32, 3);
        assert_eq!(SpellType::Transfer as u32, 4);
        assert_eq!(SpellType::PortalLink as u32, 5);
        assert_eq!(SpellType::PortalRecall as u32, 6);
        assert_eq!(SpellType::PortalSummon as u32, 7);
        assert_eq!(SpellType::PortalSending as u32, 8);
        assert_eq!(SpellType::Dispel as u32, 9);
        assert_eq!(SpellType::LifeProjectile as u32, 10);
        assert_eq!(SpellType::FellowBoost as u32, 11);
        assert_eq!(SpellType::FellowEnchantment as u32, 12);
        assert_eq!(SpellType::FellowPortalSending as u32, 13);
        assert_eq!(SpellType::FellowDispel as u32, 14);
        assert_eq!(SpellType::EnchantmentProjectile as u32, 15);

        assert_eq!(SpellType::from_repr(0), Some(SpellType::None));
        assert_eq!(SpellType::from_repr(15), Some(SpellType::EnchantmentProjectile));
        assert_eq!(SpellType::from_repr(16), None);
        assert_eq!(SpellType::default(), SpellType::None);
    }

    /// Asserts `SpellFlags` bit values match
    /// `Chorizite.Common/Enums/SpellFlags.cs:7-26`
    /// (vendored HEAD `e3b3bd2`). Enumerates every flag.
    #[test]
    fn spell_flags_values_match_chorizite() {
        assert_eq!(SpellFlags::RESISTABLE.bits(), 0x00000001);
        assert_eq!(SpellFlags::PK_SENSITIVE.bits(), 0x00000002);
        assert_eq!(SpellFlags::BENEFICIAL.bits(), 0x00000004);
        assert_eq!(SpellFlags::SELF_TARGETED.bits(), 0x00000008);
        assert_eq!(SpellFlags::REVERSED.bits(), 0x00000010);
        assert_eq!(SpellFlags::NOT_INDOOR.bits(), 0x00000020);
        assert_eq!(SpellFlags::NOT_OUTDOOR.bits(), 0x00000040);
        assert_eq!(SpellFlags::NOT_RESEARCHABLE.bits(), 0x00000080);
        assert_eq!(SpellFlags::PROJECTILE.bits(), 0x00000100);
        assert_eq!(SpellFlags::CREATURE_SPELL.bits(), 0x00000200);
        assert_eq!(SpellFlags::EXCLUDED_FROM_ITEM_DESCRIPTIONS.bits(), 0x00000400);
        assert_eq!(SpellFlags::IGNORES_MANA_CONVERSION.bits(), 0x00000800);
        assert_eq!(SpellFlags::NON_TRACKING_PROJECTILE.bits(), 0x00001000);
        assert_eq!(SpellFlags::FELLOWSHIP_SPELL.bits(), 0x00002000);
        assert_eq!(SpellFlags::FAST_CAST.bits(), 0x00004000);
        assert_eq!(SpellFlags::INDOOR_LONG_RANGE.bits(), 0x00008000);
        assert_eq!(SpellFlags::DAMAGE_OVER_TIME.bits(), 0x00010000);
        assert_eq!(SpellFlags::UNKNOWN.bits(), 0x00020000);

        // Combinable
        let combined = SpellFlags::SELF_TARGETED | SpellFlags::BENEFICIAL;
        assert_eq!(combined.bits(), 0x0C);
        assert!(combined.contains(SpellFlags::BENEFICIAL));
    }

    /// Asserts `SpellComponentType` integer values match
    /// `Chorizite.Common/Enums/SpellComponentType.cs:9-20`
    /// (vendored HEAD `e3b3bd2`). Validates alias constants for the
    /// duplicate-discriminant C# entries.
    #[test]
    fn spell_component_type_values_match_chorizite() {
        assert_eq!(SpellComponentType::Undef as u32, 0);
        assert_eq!(SpellComponentType::Scarab as u32, 1);
        assert_eq!(SpellComponentType::Herb as u32, 2);
        assert_eq!(SpellComponentType::Powder as u32, 3);
        assert_eq!(SpellComponentType::Potion as u32, 4);
        assert_eq!(SpellComponentType::Talisman as u32, 5);
        assert_eq!(SpellComponentType::Taper as u32, 6);
        assert_eq!(SpellComponentType::PotionPea as u32, 7);

        // Aliases for the duplicate-discriminant C# entries
        assert_eq!(SpellComponentType::TALISMAN_PEA as u32, 5);
        assert_eq!(SpellComponentType::TAPER_PEA as u32, 7);
        assert_eq!(SpellComponentType::TALISMAN_PEA, SpellComponentType::Talisman);
        assert_eq!(SpellComponentType::TAPER_PEA, SpellComponentType::PotionPea);

        assert_eq!(SpellComponentType::from_repr(0), Some(SpellComponentType::Undef));
        assert_eq!(SpellComponentType::from_repr(7), Some(SpellComponentType::PotionPea));
        assert_eq!(SpellComponentType::from_repr(8), None);
        assert_eq!(SpellComponentType::default(), SpellComponentType::Undef);
    }

    /// Asserts `SpellBookFilterOptions` bit values match
    /// `Chorizite.Common/Enums/SpellBookFilterOptions.cs:8-39`
    /// (vendored HEAD `e3b3bd2`). Enumerates every flag.
    #[test]
    fn spell_book_filter_options_values_match_chorizite() {
        assert_eq!(SpellBookFilterOptions::NONE.bits(), 0x00000000);
        assert_eq!(SpellBookFilterOptions::CREATURE.bits(), 0x00000001);
        assert_eq!(SpellBookFilterOptions::ITEM.bits(), 0x00000002);
        assert_eq!(SpellBookFilterOptions::LIFE.bits(), 0x00000004);
        assert_eq!(SpellBookFilterOptions::WAR.bits(), 0x00000008);
        assert_eq!(SpellBookFilterOptions::LEVEL_1.bits(), 0x00000010);
        assert_eq!(SpellBookFilterOptions::LEVEL_2.bits(), 0x00000020);
        assert_eq!(SpellBookFilterOptions::LEVEL_3.bits(), 0x00000040);
        assert_eq!(SpellBookFilterOptions::LEVEL_4.bits(), 0x00000080);
        assert_eq!(SpellBookFilterOptions::LEVEL_5.bits(), 0x00000100);
        assert_eq!(SpellBookFilterOptions::LEVEL_6.bits(), 0x00000200);
        assert_eq!(SpellBookFilterOptions::LEVEL_7.bits(), 0x00000400);
        assert_eq!(SpellBookFilterOptions::LEVEL_8.bits(), 0x00000800);
        assert_eq!(SpellBookFilterOptions::LEVEL_9.bits(), 0x00001000);
        assert_eq!(SpellBookFilterOptions::VOID.bits(), 0x00002000);

        // Combinable: filter for level-3 war spells
        let combined = SpellBookFilterOptions::WAR | SpellBookFilterOptions::LEVEL_3;
        assert_eq!(combined.bits(), 0x48);
        assert!(combined.contains(SpellBookFilterOptions::WAR));
        assert!(combined.contains(SpellBookFilterOptions::LEVEL_3));
    }
}
