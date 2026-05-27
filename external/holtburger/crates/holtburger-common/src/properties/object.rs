use bitflags::bitflags;
use serde::{Deserialize, Serialize};
use strum_macros::{Display, FromRepr};

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
    pub struct ObjectDescriptionFlag: u32 {
        const NONE = 0x00000000;
        const OPENABLE = 0x00000001;
        const INSCRIBABLE = 0x00000002;
        const STUCK = 0x00000004;
        const PLAYER = 0x00000008;
        const ATTACKABLE = 0x00000010;
        const PLAYER_KILLER = 0x00000020;
        const HIDDEN_ADMIN = 0x00000040;
        const UI_HIDDEN = 0x00000080;
        const BOOK = 0x00000100;
        const VENDOR = 0x00000200;
        const PK_SWITCH = 0x00000400;
        const NPK_SWITCH = 0x00000800;
        const DOOR = 0x00001000;
        const CORPSE = 0x00002000;
        const LIFE_STONE = 0x00004000;
        const FOOD = 0x00008000;
        const HEALER = 0x00010000;
        const LOCKPICK = 0x00020000;
        const PORTAL = 0x00040000;
        const ADMIN = 0x00100000;
        const FREE_PK_STATUS = 0x00200000;
        const IMMUNE_CELL_RESTRICTIONS = 0x00400000;
        const REQUIRES_PACK_SLOT = 0x00800000;
        const RETAINED = 0x01000000;
        const PK_LITE_STATUS = 0x02000000;
        const INCLUDES_SECOND_HEADER = 0x04000000;
        const BIND_STONE = 0x08000000;
        const VOLATILE_RARE = 0x10000000;
        const WIELD_ON_USE = 0x20000000;
        const WIELD_LEFT = 0x40000000;
    }
}

bitflags! {
    /// Physics flag bitmask carried on every world object.
    ///
    /// Bit values verified bit-for-bit against retail `acclient.exe`
    /// (IDA-recovered debug info, `~/ac-headers/acclient.h` enum
    /// `PhysicsState`). ACE's port at `ACE.Entity/Enum/PhysicsState.cs`
    /// uses identical bits with PascalCase names (`Static`, `NoDraw`).
    ///
    /// `NONE` is a Rust convenience for `empty()` and has no analog
    /// in the retail binary. `UNUSED1` / `UNUSED2` are gaps the retail
    /// enum left in place; they are reserved and should not be set.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
    pub struct PhysicsState: u32 {
        const NONE                          = 0x00000000;
        const STATIC                        = 0x00000001;
        const UNUSED1                       = 0x00000002;
        const ETHEREAL                      = 0x00000004;
        const REPORT_COLLISIONS             = 0x00000008;
        const IGNORE_COLLISIONS             = 0x00000010;
        const NO_DRAW                       = 0x00000020;
        const MISSILE                       = 0x00000040;
        const PUSHABLE                      = 0x00000080;
        const ALIGN_PATH                    = 0x00000100;
        const PATH_CLIPPED                  = 0x00000200;
        const GRAVITY                       = 0x00000400;
        const LIGHTING_ON                   = 0x00000800;
        const PARTICLE_EMITTER              = 0x00001000;
        const UNUSED2                       = 0x00002000;
        const HIDDEN                        = 0x00004000;
        const SCRIPTED_COLLISION            = 0x00008000;
        const HAS_PHYSICS_BSP               = 0x00010000;
        const INELASTIC                     = 0x00020000;
        const HAS_DEFAULT_ANIM              = 0x00040000;
        const HAS_DEFAULT_SCRIPT            = 0x00080000;
        const CLOAKED                       = 0x00100000;
        const REPORT_COLLISIONS_AS_ENVIRONMENT = 0x00200000;
        const EDGE_SLIDE                    = 0x00400000;
        const SLEDDING                      = 0x00800000;
        const FROZEN                        = 0x01000000;
    }
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
    pub struct WeenieHeaderFlag: u32 {
        const NONE = 0x00000000;
        const PLURAL_NAME = 0x00000001;
        const ITEMS_CAPACITY = 0x00000002;
        const CONTAINERS_CAPACITY = 0x00000004;
        const VALUE = 0x00000008;
        const USABLE = 0x00000010;
        const USE_RADIUS = 0x00000020;
        const MONARCH = 0x00000040;
        const UI_EFFECTS = 0x00000080;
        const AMMO_TYPE = 0x00000100;
        const COMBAT_USE = 0x00000200;
        const STRUCTURE = 0x00000400;
        const MAX_STRUCTURE = 0x00000800;
        const STACK_SIZE = 0x00001000;
        const MAX_STACK_SIZE = 0x00002000;
        const CONTAINER = 0x00004000;
        const WIELDER = 0x00008000;
        const VALID_LOCATIONS = 0x00010000;
        const CURRENTLY_WIELDED_LOCATION = 0x00020000;
        const PRIORITY = 0x00040000;
        const TARGET_TYPE = 0x00080000;
        const RADAR_BLIP_COLOR = 0x00100000;
        const BURDEN = 0x00200000;
        const SPELL = 0x00400000;
        const RADAR_BEHAVIOR = 0x00800000;
        const WORKMANSHIP = 0x01000000;
        const HOUSE_OWNER = 0x02000000;
        const HOUSE_RESTRICTIONS = 0x04000000;
        const PSCRIPT = 0x08000000;
        const HOOK_TYPE = 0x10000000;
        const HOOK_ITEM_TYPES = 0x20000000;
        const ICON_OVERLAY = 0x40000000;
        const MATERIAL_TYPE = 0x80000000;
    }
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
    pub struct WeenieHeaderFlag2: u32 {
        const NONE = 0x00;
        const ICON_UNDERLAY = 0x01;
        const COOLDOWN = 0x02;
        const COOLDOWN_DURATION = 0x04;
        const PET_OWNER = 0x08;
    }
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    pub struct PhysicsDescriptionFlag: u32 {
        const NONE = 0x000000;
        const CSETUP = 0x000001;
        const MTABLE = 0x000002;
        const VELOCITY = 0x000004;
        const ACCELERATION = 0x000008;
        const OMEGA = 0x000010;
        const PARENT = 0x000020;
        const CHILDREN = 0x000040;
        const OBJSCALE = 0x000080;
        const FRICTION = 0x000100;
        const ELASTICITY = 0x000200;
        const TIMESTAMPS = 0x000400;
        const STABLE = 0x000800;
        const PETABLE = 0x001000;
        const DEFAULT_SCRIPT = 0x002000;
        const DEFAULT_SCRIPT_INTENSITY = 0x004000;
        const POSITION = 0x008000;
        const MOVEMENT = 0x010000;
        const ANIMATION_FRAME = 0x020000;
        const TRANSLUCENCY = 0x040000;
    }
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    pub struct IdentifyResponseFlags: u32 {
        const NONE = 0x0000;
        const INT_STATS_TABLE = 0x0001;
        const BOOL_STATS_TABLE = 0x0002;
        const FLOAT_STATS_TABLE = 0x0004;
        const STRING_STATS_TABLE = 0x0008;
        const SPELL_BOOK = 0x0010;
        const WEAPON_PROFILE = 0x0020;
        const HOOK_PROFILE = 0x0040;
        const ARMOR_PROFILE = 0x0080;
        const CREATURE_PROFILE = 0x0100;
        const ARMOR_ENCHANTMENT_BITFIELD = 0x0200;
        const RESIST_ENCHANTMENT_BITFIELD = 0x0400;
        const WEAPON_ENCHANTMENT_BITFIELD = 0x0800;
        const DID_STATS_TABLE = 0x1000;
        const INT64_STATS_TABLE = 0x2000;
        const ARMOR_LEVELS = 0x4000;
    }
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    pub struct GfxObjFlags: u32 {
        const NONE = 0x00000000;
        const HAS_PHYSICS = 0x00000001;
        const HAS_DRAWING = 0x00000002;
        const UNKNOWN = 0x00000004;
        const HAS_DID_DEGRADE = 0x00000008;
    }
}

/// Weenie taxonomy. Mirrors `Chorizite.Common.Enums.WeenieType` /
/// `ACE.Entity.Enum.WeenieType` (the two diverge only on the value-0
/// sentinel name: ACE = `Undef`, Chorizite = `None`). We use `Undef = 0`
/// to follow the ACE-wins precedence; the Chorizite `None ↔ Rust Undef`
/// rename is documented as an allowlisted divergence in
/// `WorldBuilder.Terminal/CommandEngine.EnumParity.cs:ManualEnumMapping`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WeenieType {
    Undef = 0,
    Generic = 1,
    Clothing = 2,
    MissileLauncher = 3,
    Missile = 4,
    Ammunition = 5,
    MeleeWeapon = 6,
    Portal = 7,
    Book = 8,
    Coin = 9,
    Creature = 10,
    Admin = 11,
    Vendor = 12,
    HotSpot = 13,
    Corpse = 14,
    Cow = 15,
    AI = 16,
    Machine = 17,
    Food = 18,
    Door = 19,
    Chest = 20,
    Container = 21,
    Key = 22,
    Lockpick = 23,
    PressurePlate = 24,
    LifeStone = 25,
    Switch = 26,
    PKModifier = 27,
    Healer = 28,
    LightSource = 29,
    Allegiance = 30,
    /// Chorizite uses `UNKNOWN__GUESSEDNAME32` for slot 31 (an
    /// unidentified retail weenie type sometimes labelled "guessed
    /// name 32"). ACE labels it identically.
    #[allow(non_camel_case_types)]
    UNKNOWN__GUESSEDNAME32 = 31,
    SpellComponent = 32,
    ProjectileSpell = 33,
    Scroll = 34,
    Caster = 35,
    Channel = 36,
    ManaStone = 37,
    Gem = 38,
    AdvocateFane = 39,
    AdvocateItem = 40,
    Sentinel = 41,
    GSpellEconomy = 42,
    LSpellEconomy = 43,
    CraftTool = 44,
    LScoreKeeper = 45,
    GScoreKeeper = 46,
    GScoreGatherer = 47,
    ScoreBook = 48,
    EventCoordinator = 49,
    Entity = 50,
    Stackable = 51,
    HUD = 52,
    House = 53,
    Deed = 54,
    SlumLord = 55,
    Hook = 56,
    Storage = 57,
    BootSpot = 58,
    HousePortal = 59,
    Game = 60,
    GamePiece = 61,
    SkillAlterationDevice = 62,
    AttributeTransferDevice = 63,
    Hooker = 64,
    AllegianceBindstone = 65,
    InGameStatKeeper = 66,
    AugmentationDevice = 67,
    SocialManager = 68,
    Pet = 69,
    PetDevice = 70,
    CombatPet = 71,
}

/// Decal-compatible object class taxonomy. Mirrors
/// `Chorizite.Common.Enums.ObjectClass`
/// (`Chorizite.Common/Enums/ObjectClass.cs:9-55`, vendored HEAD `e3b3bd2`).
///
/// Unlocks typed WorldObject subclass dispatch — currently we use generic
/// Entity for everything. Drives equipment slot logic, NPC categorization,
/// container vs item distinction.
///
/// The C# enum has no explicit discriminants — values follow `Unknown = 0`
/// declaration order. Discriminants below mirror that order verbatim
/// (`Unknown = 0` ... `Static = 44`, 45 variants total).
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
pub enum ObjectClass {
    #[default]
    Unknown = 0,
    MeleeWeapon = 1,
    Armor = 2,
    Clothing = 3,
    Jewelry = 4,
    Monster = 5,
    Food = 6,
    Money = 7,
    Misc = 8,
    MissileWeapon = 9,
    Container = 10,
    Gem = 11,
    SpellComponent = 12,
    Key = 13,
    Portal = 14,
    TradeNote = 15,
    ManaStone = 16,
    Plant = 17,
    BaseCooking = 18,
    BaseAlchemy = 19,
    BaseFletching = 20,
    CraftedCooking = 21,
    CraftedAlchemy = 22,
    CraftedFletching = 23,
    Player = 24,
    Vendor = 25,
    Door = 26,
    Corpse = 27,
    Lifestone = 28,
    HealingKit = 29,
    Lockpick = 30,
    WandStaffOrb = 31,
    Bundle = 32,
    Book = 33,
    Journal = 34,
    Sign = 35,
    Housing = 36,
    Npc = 37,
    Foci = 38,
    Salvage = 39,
    Ust = 40,
    Services = 41,
    Scroll = 42,
    Bindstone = 43,
    Static = 44,
}

#[cfg(test)]
mod object_class_tests {
    use super::*;

    /// Asserts integer values match `Chorizite.Common/Enums/ObjectClass.cs:9-55`
    /// (vendored HEAD `e3b3bd2`) — C# enum without explicit discriminants,
    /// so values follow declaration order starting at `Unknown = 0`.
    #[test]
    fn object_class_values_match_chorizite() {
        assert_eq!(ObjectClass::Unknown as u32, 0);
        assert_eq!(ObjectClass::MeleeWeapon as u32, 1);
        assert_eq!(ObjectClass::Armor as u32, 2);
        assert_eq!(ObjectClass::Clothing as u32, 3);
        assert_eq!(ObjectClass::Jewelry as u32, 4);
        assert_eq!(ObjectClass::Monster as u32, 5);
        assert_eq!(ObjectClass::Food as u32, 6);
        assert_eq!(ObjectClass::Money as u32, 7);
        assert_eq!(ObjectClass::Misc as u32, 8);
        assert_eq!(ObjectClass::MissileWeapon as u32, 9);
        assert_eq!(ObjectClass::Container as u32, 10);
        assert_eq!(ObjectClass::Gem as u32, 11);
        assert_eq!(ObjectClass::SpellComponent as u32, 12);
        assert_eq!(ObjectClass::Key as u32, 13);
        assert_eq!(ObjectClass::Portal as u32, 14);
        assert_eq!(ObjectClass::TradeNote as u32, 15);
        assert_eq!(ObjectClass::ManaStone as u32, 16);
        assert_eq!(ObjectClass::Plant as u32, 17);
        assert_eq!(ObjectClass::BaseCooking as u32, 18);
        assert_eq!(ObjectClass::BaseAlchemy as u32, 19);
        assert_eq!(ObjectClass::BaseFletching as u32, 20);
        assert_eq!(ObjectClass::CraftedCooking as u32, 21);
        assert_eq!(ObjectClass::CraftedAlchemy as u32, 22);
        assert_eq!(ObjectClass::CraftedFletching as u32, 23);
        assert_eq!(ObjectClass::Player as u32, 24);
        assert_eq!(ObjectClass::Vendor as u32, 25);
        assert_eq!(ObjectClass::Door as u32, 26);
        assert_eq!(ObjectClass::Corpse as u32, 27);
        assert_eq!(ObjectClass::Lifestone as u32, 28);
        assert_eq!(ObjectClass::HealingKit as u32, 29);
        assert_eq!(ObjectClass::Lockpick as u32, 30);
        assert_eq!(ObjectClass::WandStaffOrb as u32, 31);
        assert_eq!(ObjectClass::Bundle as u32, 32);
        assert_eq!(ObjectClass::Book as u32, 33);
        assert_eq!(ObjectClass::Journal as u32, 34);
        assert_eq!(ObjectClass::Sign as u32, 35);
        assert_eq!(ObjectClass::Housing as u32, 36);
        assert_eq!(ObjectClass::Npc as u32, 37);
        assert_eq!(ObjectClass::Foci as u32, 38);
        assert_eq!(ObjectClass::Salvage as u32, 39);
        assert_eq!(ObjectClass::Ust as u32, 40);
        assert_eq!(ObjectClass::Services as u32, 41);
        assert_eq!(ObjectClass::Scroll as u32, 42);
        assert_eq!(ObjectClass::Bindstone as u32, 43);
        assert_eq!(ObjectClass::Static as u32, 44);

        // Round-trip via FromRepr
        assert_eq!(ObjectClass::from_repr(0), Some(ObjectClass::Unknown));
        assert_eq!(ObjectClass::from_repr(28), Some(ObjectClass::Lifestone));
        assert_eq!(ObjectClass::from_repr(44), Some(ObjectClass::Static));
        assert_eq!(ObjectClass::from_repr(45), None);
        assert_eq!(ObjectClass::from_repr(100), None);

        // Default value
        assert_eq!(ObjectClass::default(), ObjectClass::Unknown);
    }
}
