pub mod action_map;
pub mod animation;
pub mod bad_data;
pub mod char_gen;
pub mod chat_pose_table;
pub mod clothing;
pub mod combat_maneuver_table;
pub mod contract_table;
pub mod degrade_info;
pub mod did_mapper;
pub mod dual_did_mapper;
pub mod dxt;
pub mod enum_mapper;
pub mod env_cell;
pub mod environment;
pub mod font;
pub mod game_time;
pub mod gfx_obj;
pub mod iteration;
pub mod keymap;
pub mod language_string;
pub mod layout;
pub mod master_property;
pub mod media_desc;
pub mod motion_kinematics;
pub mod motion_table;
pub mod name_filter_table;
pub mod object_desc;
pub mod palette;
pub mod palette_set;
pub mod particle_emitter;
pub mod physics_script;
pub mod physics_script_table;
pub mod quality_filter;
pub mod region;
pub mod render_texture;
pub mod scene;
pub mod setup_model;
pub mod setup_model_hooks;
pub mod skill_table;
pub mod sound_table;
pub mod spell_components_table;
pub mod spell_table;
pub mod state_desc;
pub mod string_table;
pub mod surface;
pub mod surface_texture;
pub mod taboo_table;
pub mod texture;
pub mod wave;
pub mod xp_table;

pub use action_map::{ActionMap, ActionMapValue, InputMapConflictsValue, UserBindingValue};
pub use animation::Animation;
pub use bad_data::BadData;
pub use char_gen::CharGen;
pub use chat_pose_table::{ChatEmoteData, ChatPoseTable};
pub use clothing::{
    CloObjectEffect, CloSubPalEffect, CloSubPalette, CloSubPaletteRange, CloTextureEffect,
    ClothingBaseEffect, ClothingTable,
};
pub use combat_maneuver_table::{CombatManeuver, CombatManeuverTable};
pub use contract_table::{Contract, ContractPosition, ContractTable};
pub use degrade_info::{GfxObjDegradeInfo, GfxObjInfo};
pub use did_mapper::DidMapper;
pub use dual_did_mapper::DualDidMapper;
pub use enum_mapper::{EnumMapper, NumberingType};
pub use env_cell::EnvCell;
pub use environment::{CellStruct, Environment};
pub use font::{Font, FontCharDesc};
pub use game_time::{GameTime, Season, TimeOfDay};
pub use gfx_obj::GfxObj;
pub use iteration::Iteration;
pub use keymap::{CInputMap, ControlSpecification, DeviceKeyMapEntry, KeyMap, QualifiedControl};
pub use language_string::LanguageString;
pub use layout::{ElementDesc, LayoutDesc};
pub use master_property::{
    BaseProperty, BasePropertyDesc, BasePropertyType, EnumMapperData, MasterProperty,
};
pub use media_desc::{MediaDesc, MediaType};
pub use motion_kinematics::{MotionKinematics, MotionKinematicsTable};
// T1-base-speed/T7: re-export MotionData so the wasm crate (lib.rs) can name
// the type when resolving the authored-speed fallback chain (velocity ->
// kinematics -> get_anim_dist) and read the T7 bitfield accessors.
pub use motion_table::{
    AnimData, MotionCommandKinematics, MotionData, MotionTable, MotionTableMovementProfile,
};
pub use name_filter_table::{NameFilterLanguageData, NameFilterTable};
pub use object_desc::ObjectDesc;
pub use palette::Palette;
pub use palette_set::PaletteSet;
pub use particle_emitter::ParticleEmitter;
pub use physics_script::{PhysicsScript, PhysicsScriptData};
pub use physics_script_table::{
    PhysicsScriptTable, PhysicsScriptTableData, PhysicsScriptTableEntry,
};
pub use quality_filter::QualityFilter;
pub use region::{
    DayGroup, LandDefs, Region, RegionMisc, SceneDesc, SkyDesc, SkyObject, SkyObjectReplace,
    SkyTimeOfDay, SoundDesc, TerrainDesc,
};
pub use scene::Scene;
pub use setup_model::SetupModel;
pub use setup_model_hooks::AnimationHookData;
pub use skill_table::SkillTable;
pub use sound_table::{SoundData, SoundEntry, SoundHashData, SoundTable};
pub use spell_components_table::{SpellComponent, SpellComponentsTable};
pub use spell_table::SpellTable;
pub use state_desc::StateDesc;
pub use string_table::{StringTable, StringTableString};
pub use render_texture::RenderTexture;
pub use surface::{Surface, TextureRefs as SurfaceTextureRefs};
pub use surface_texture::SurfaceTexture;
pub use taboo_table::{TabooTable, TabooTableEntry};
pub use texture::{SurfacePixelFormat, Texture, TextureDecodeError};
pub use wave::{PcmFormat, Wave, WAVEFORMATEX_SIZE};
pub use xp_table::XpTable;

use std::fmt;

pub const MOTION_KINEMATICS_TYPE_ID: u32 = 0xFFFF_FF01;

/// Which retail DAT a given file ID came from. The cell DAT encodes the
/// landblock X-coordinate in the top byte (0x00–0xFE), so classifying a cell
/// ID by its prefix the way you would a portal ID misreads ~25% of indoor
/// cells as portal types. Pass this when classifying to disambiguate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DatKind {
    /// `client_portal.dat` — top byte is the type tag.
    Portal,
    /// `client_cell_*.dat` — top byte is the landblock X-coordinate;
    /// type is encoded in the suffix (`FFFF`=Landblock, `FFFE`=LandblockInfo,
    /// otherwise IndoorCell).
    Cell,
    /// `client_local_*.dat` — uses portal-style prefix dispatch.
    Local,
    /// Unknown source — fall back to legacy heuristic dispatch.
    Unknown,
}

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DatFileType {
    // Portal Range (Top Byte)
    Model = 0x01,
    SetupModel = 0x02,
    Animation = 0x03,
    Palette = 0x04,
    SurfaceTexture = 0x05,
    Texture = 0x06,
    Surface = 0x08,
    MotionTable = 0x09,
    Audio = 0x0A,
    EnvCell = 0x0D,
    Table = 0x0E,
    PaletteSet = 0x0F,
    Clothing = 0x10,
    DegradeInfo = 0x11,
    Scene = 0x12,
    Region = 0x13,
    Keymap = 0x14,
    RenderTexture = 0x15,
    RenderMaterial = 0x16,
    MaterialModifier = 0x17,
    MaterialInstance = 0x18,
    RenderMesh = 0x19,
    SoundTable = 0x20,
    Layout = 0x21,
    EnumMapper = 0x22,
    StringTable = 0x23,
    StringTableString = 0x24,
    DataIDMapper = 0x25,
    ActionMap = 0x26,
    DualDataIDMapper = 0x27,
    CombatManeuverTable = 0x30,
    LanguageString = 0x31,
    ParticleEmitter = 0x32,
    PhysicsScript = 0x33,
    PhysicsScriptTable = 0x34,
    MutateFilter = 0x38,
    MasterProperty = 0x39,
    Font = 0x40,
    StringState = 0x41,
    BSPNodeType = 0x42,
    DatabaseProperties = 0x78,
    Custom = 0xFFFF_FF00,
    MotionKinematics = MOTION_KINEMATICS_TYPE_ID,

    // Cell Range (Suffix)
    Landblock = 0xFE, // XXYYFFFF (using FE as internal marker for simplicity or specific logic)
    LandblockInfo = 0xFF, // XXYYFFFE
    IndoorCell = 0xFD, // XXYY0001 - XXYYFFFD
    Iteration = 0xFE01, // 0xFFFF0001 - Special DAT metadata record

    Unknown = 0x00,
}

impl DatFileType {
    pub fn is_essential(&self) -> bool {
        matches!(
            self,
            DatFileType::Model
                | DatFileType::SetupModel
                | DatFileType::MotionTable
                | DatFileType::EnvCell
                | DatFileType::Table
                | DatFileType::Region
                | DatFileType::SoundTable
                | DatFileType::CombatManeuverTable
                | DatFileType::PhysicsScript
                | DatFileType::PhysicsScriptTable
                | DatFileType::Landblock
                | DatFileType::LandblockInfo
                | DatFileType::IndoorCell
        )
    }

    /// Legacy DAT-context-blind classifier. Prefer
    /// [`Self::from_id_in_dat`] when the source DAT is known — this
    /// function misreads cell-DAT IDs whose landblock X-coordinate falls
    /// in `0x01..=0x40` (it returns the portal-type variant for that
    /// prefix instead of `IndoorCell`).
    pub fn from_id(id: u32) -> Self {
        // Special internal files
        if id == 0xFFFF0001 {
            return DatFileType::Iteration;
        }

        // Check Cell DAT suffixes first (high priority)
        let suffix = id & 0xFFFF;
        if suffix == 0xFFFF {
            return DatFileType::Landblock;
        }
        if suffix == 0xFFFE {
            return DatFileType::LandblockInfo;
        }

        // Try portal-prefix dispatch; fall back to IndoorCell when the prefix
        // is not a known portal type but the suffix is in the cell range.
        let prefix = (id >> 24) as u8;
        let portal_guess = Self::classify_portal_prefix(prefix);
        if portal_guess != DatFileType::Unknown {
            return portal_guess;
        }
        if suffix > 0 && suffix < 0xFFFE {
            DatFileType::IndoorCell
        } else {
            DatFileType::Unknown
        }
    }

    /// Classify a file ID with explicit DAT context.
    ///
    /// The portal and cell DATs reuse the same 32-bit ID space with
    /// different conventions: portal IDs put the type tag in the top byte,
    /// cell IDs put the landblock X-coordinate (0x00–0xFE) there. Without
    /// context, cell entries with X ≤ 0x40 collide with portal type tags
    /// and get misclassified (vitaeum-comparison 2026-05-23: 194,935 cell
    /// IndoorCells were misread as portal types under the legacy
    /// [`Self::from_id`]).
    pub fn from_id_in_dat(id: u32, dat_kind: DatKind) -> Self {
        if id == 0xFFFF0001 {
            return DatFileType::Iteration;
        }

        let suffix = id & 0xFFFF;
        let prefix = (id >> 24) as u8;

        match dat_kind {
            DatKind::Cell => {
                if suffix == 0xFFFF {
                    DatFileType::Landblock
                } else if suffix == 0xFFFE {
                    DatFileType::LandblockInfo
                } else if suffix > 0 && suffix < 0xFFFE {
                    DatFileType::IndoorCell
                } else {
                    DatFileType::Unknown
                }
            }
            DatKind::Portal | DatKind::Local => Self::classify_portal_prefix(prefix),
            DatKind::Unknown => Self::from_id(id),
        }
    }

    fn classify_portal_prefix(prefix: u8) -> Self {
        match prefix {
            0x01 => DatFileType::Model,
            0x02 => DatFileType::SetupModel,
            0x03 => DatFileType::Animation,
            0x04 => DatFileType::Palette,
            0x05 => DatFileType::SurfaceTexture,
            0x06 | 0x07 => DatFileType::Texture,
            0x08 => DatFileType::Surface,
            0x09 => DatFileType::MotionTable,
            0x0A => DatFileType::Audio,
            0x0D => DatFileType::EnvCell,
            0x0E => DatFileType::Table,
            0x0F => DatFileType::PaletteSet,
            0x10 => DatFileType::Clothing,
            0x11 => DatFileType::DegradeInfo,
            0x12 => DatFileType::Scene,
            0x13 => DatFileType::Region,
            0x14 => DatFileType::Keymap,
            0x15 => DatFileType::RenderTexture,
            0x16 => DatFileType::RenderMaterial,
            0x17 => DatFileType::MaterialModifier,
            0x18 => DatFileType::MaterialInstance,
            0x19 => DatFileType::RenderMesh,
            0x20 => DatFileType::SoundTable,
            0x21 => DatFileType::Layout,
            0x22 => DatFileType::EnumMapper,
            0x23 => DatFileType::StringTable,
            0x24 => DatFileType::StringTableString,
            0x25 => DatFileType::DataIDMapper,
            0x26 => DatFileType::ActionMap,
            0x27 => DatFileType::DualDataIDMapper,
            0x30 => DatFileType::CombatManeuverTable,
            0x31 => DatFileType::LanguageString,
            0x32 => DatFileType::ParticleEmitter,
            0x33 => DatFileType::PhysicsScript,
            0x34 => DatFileType::PhysicsScriptTable,
            0x38 => DatFileType::MutateFilter,
            0x39 => DatFileType::MasterProperty,
            0x40 => DatFileType::Font,
            0x41 => DatFileType::StringState,
            0x42 => DatFileType::BSPNodeType,
            0x78 => DatFileType::DatabaseProperties,
            _ => DatFileType::Unknown,
        }
    }

    pub fn from_type_id(type_id: u32) -> Self {
        match type_id {
            0x01 => DatFileType::Model,
            0x02 => DatFileType::SetupModel,
            0x03 => DatFileType::Animation,
            0x04 => DatFileType::Palette,
            0x05 => DatFileType::SurfaceTexture,
            0x06 => DatFileType::Texture,
            0x08 => DatFileType::Surface,
            0x09 => DatFileType::MotionTable,
            0x0A => DatFileType::Audio,
            0x0D => DatFileType::EnvCell,
            0x0E => DatFileType::Table,
            0x0F => DatFileType::PaletteSet,
            0x10 => DatFileType::Clothing,
            0x11 => DatFileType::DegradeInfo,
            0x12 => DatFileType::Scene,
            0x13 => DatFileType::Region,
            0x14 => DatFileType::Keymap,
            0x15 => DatFileType::RenderTexture,
            0x16 => DatFileType::RenderMaterial,
            0x17 => DatFileType::MaterialModifier,
            0x18 => DatFileType::MaterialInstance,
            0x19 => DatFileType::RenderMesh,
            0x20 => DatFileType::SoundTable,
            0x21 => DatFileType::Layout,
            0x22 => DatFileType::EnumMapper,
            0x23 => DatFileType::StringTable,
            0x24 => DatFileType::StringTableString,
            0x25 => DatFileType::DataIDMapper,
            0x26 => DatFileType::ActionMap,
            0x27 => DatFileType::DualDataIDMapper,
            0x30 => DatFileType::CombatManeuverTable,
            0x31 => DatFileType::LanguageString,
            0x32 => DatFileType::ParticleEmitter,
            0x33 => DatFileType::PhysicsScript,
            0x34 => DatFileType::PhysicsScriptTable,
            0x38 => DatFileType::MutateFilter,
            0x39 => DatFileType::MasterProperty,
            0x40 => DatFileType::Font,
            0x41 => DatFileType::StringState,
            0x42 => DatFileType::BSPNodeType,
            0x78 => DatFileType::DatabaseProperties,
            0xFD => DatFileType::IndoorCell,
            0xFE => DatFileType::Landblock,
            0xFE01 => DatFileType::Iteration,
            0xFF => DatFileType::LandblockInfo,
            0xFFFF_FF00 => DatFileType::Custom,
            MOTION_KINEMATICS_TYPE_ID => DatFileType::MotionKinematics,
            _ => DatFileType::Unknown,
        }
    }
}

impl fmt::Display for DatFileType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            DatFileType::Model => "Model (OBJ)",
            DatFileType::SetupModel => "SetupModel (SET)",
            DatFileType::Animation => "Animation (ANM)",
            DatFileType::Palette => "Palette (PAL)",
            DatFileType::SurfaceTexture => "SurfaceTexture (TEX)",
            DatFileType::Texture => "Texture (DDS/JPG)",
            DatFileType::Surface => "Surface (SUR)",
            DatFileType::MotionTable => "MotionTable (DSC)",
            DatFileType::Audio => "Audio (WAV)",
            DatFileType::EnvCell => "EnvCell (ENV)",
            DatFileType::Table => "Table",
            DatFileType::PaletteSet => "PaletteSet",
            DatFileType::Clothing => "Clothing (CLO)",
            DatFileType::DegradeInfo => "DegradeInfo",
            DatFileType::Scene => "Scene (SCN)",
            DatFileType::Region => "Region (RGN)",
            DatFileType::Keymap => "Keymap",
            DatFileType::RenderTexture => "RenderTexture",
            DatFileType::RenderMaterial => "RenderMaterial",
            DatFileType::MaterialModifier => "MaterialModifier",
            DatFileType::MaterialInstance => "MaterialInstance",
            DatFileType::RenderMesh => "RenderMesh",
            DatFileType::SoundTable => "SoundTable (STB)",
            DatFileType::Layout => "Layout",
            DatFileType::EnumMapper => "EnumMapper",
            DatFileType::StringTable => "StringTable",
            DatFileType::StringTableString => "StringTableString",
            DatFileType::DataIDMapper => "DataIDMapper",
            DatFileType::ActionMap => "ActionMap",
            DatFileType::DualDataIDMapper => "DualDataIDMapper",
            DatFileType::CombatManeuverTable => "CombatManeuverTable",
            DatFileType::ParticleEmitter => "ParticleEmitter",
            DatFileType::PhysicsScript => "PhysicsScript",
            DatFileType::PhysicsScriptTable => "PhysicsScriptTable",
            DatFileType::LanguageString => "LanguageString",
            DatFileType::MutateFilter => "MutateFilter",
            DatFileType::MasterProperty => "MasterProperty",
            DatFileType::Font => "Font",
            DatFileType::StringState => "StringState",
            DatFileType::BSPNodeType => "BSPNodeType",
            DatFileType::DatabaseProperties => "DatabaseProperties",
            DatFileType::Custom => "Custom",
            DatFileType::MotionKinematics => "MotionKinematics",
            DatFileType::Landblock => "Landblock (Terrain)",
            DatFileType::LandblockInfo => "LandblockInfo (Static)",
            DatFileType::IndoorCell => "IndoorCell",
            DatFileType::Iteration => "Iteration (Metadata)",
            DatFileType::Unknown => "Unknown",
        };
        write!(f, "{}", name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_type_classification() {
        // Special internal iterations file
        assert_eq!(DatFileType::from_id(0xFFFF0001), DatFileType::Iteration);

        // Terrain landblocks
        assert_eq!(DatFileType::from_id(0x1234FFFF), DatFileType::Landblock);

        // Static objects in landblocks (LBI)
        assert_eq!(DatFileType::from_id(0x1234FFFE), DatFileType::LandblockInfo);

        // Interior/Dungeon cells
        assert_eq!(DatFileType::from_id(0x76540001), DatFileType::IndoorCell);
        assert_eq!(DatFileType::from_id(0x7654FDAB), DatFileType::IndoorCell);

        // Portal types (by prefix)
        assert_eq!(DatFileType::from_id(0x01001234), DatFileType::Model);
        assert_eq!(DatFileType::from_id(0x02001234), DatFileType::SetupModel);
        assert_eq!(DatFileType::from_id(0x0E001234), DatFileType::Table);

        // Edge case: ensure 0xFFFF0001 is NOT an IndoorCell
        assert_ne!(DatFileType::from_id(0xFFFF0001), DatFileType::IndoorCell);

        assert_eq!(DatFileType::from_type_id(0x0E), DatFileType::Table);
        assert_eq!(DatFileType::from_type_id(0xFFFF_FF00), DatFileType::Custom);
        assert_eq!(
            DatFileType::from_type_id(MOTION_KINEMATICS_TYPE_ID),
            DatFileType::MotionKinematics
        );
        assert_eq!(DatFileType::from_type_id(0xDEADBEEF), DatFileType::Unknown);
    }

    #[test]
    fn test_from_id_in_dat_disambiguates_cell_vs_portal() {
        // Same byte pattern, different DAT context, different meaning.
        // `0x01000042` in portal.dat is a GfxObj/Model; in cell.dat it's
        // an indoor cell at landblock X=0x01, Y=0x00, cell 0x0042.
        assert_eq!(
            DatFileType::from_id_in_dat(0x01000042, DatKind::Portal),
            DatFileType::Model
        );
        assert_eq!(
            DatFileType::from_id_in_dat(0x01000042, DatKind::Cell),
            DatFileType::IndoorCell
        );

        // Cell-DAT terrain + LBI markers ignore the prefix entirely.
        assert_eq!(
            DatFileType::from_id_in_dat(0x0100FFFF, DatKind::Cell),
            DatFileType::Landblock
        );
        assert_eq!(
            DatFileType::from_id_in_dat(0x0100FFFE, DatKind::Cell),
            DatFileType::LandblockInfo
        );

        // High-X-coord cells already worked under legacy from_id, still work here.
        assert_eq!(
            DatFileType::from_id_in_dat(0xA9B40042, DatKind::Cell),
            DatFileType::IndoorCell
        );

        // Portal types the legacy from_id misread as IndoorCell are now correct.
        assert_eq!(
            DatFileType::from_id_in_dat(0x0F000001, DatKind::Portal),
            DatFileType::PaletteSet
        );
        assert_eq!(
            DatFileType::from_id_in_dat(0x11000000, DatKind::Portal),
            DatFileType::DegradeInfo
        );
        assert_eq!(
            DatFileType::from_id_in_dat(0x15000001, DatKind::Portal),
            DatFileType::RenderTexture
        );
        assert_eq!(
            DatFileType::from_id_in_dat(0x78000001, DatKind::Portal),
            DatFileType::DatabaseProperties
        );

        // Local DAT (client_local_*.dat) uses portal-style dispatch.
        assert_eq!(
            DatFileType::from_id_in_dat(0x21000001, DatKind::Local),
            DatFileType::Layout
        );
        assert_eq!(
            DatFileType::from_id_in_dat(0x23000001, DatKind::Local),
            DatFileType::StringTable
        );

        // Iteration metadata is recognized regardless of context.
        for kind in [DatKind::Portal, DatKind::Cell, DatKind::Local, DatKind::Unknown] {
            assert_eq!(
                DatFileType::from_id_in_dat(0xFFFF0001, kind),
                DatFileType::Iteration,
            );
        }

        // Unknown context falls back to legacy heuristic.
        assert_eq!(
            DatFileType::from_id_in_dat(0x01000042, DatKind::Unknown),
            DatFileType::from_id(0x01000042),
        );
    }

    #[test]
    fn test_essential_types() {
        let manifest = crate::manifest::StripperManifest::logic_only();

        // Iteration should NOT be essential
        assert!(!manifest.should_keep(DatFileType::Iteration));

        // Models and Landblocks should be essential
        assert!(manifest.should_keep(DatFileType::Model));
        assert!(manifest.should_keep(DatFileType::Landblock));
    }
}
