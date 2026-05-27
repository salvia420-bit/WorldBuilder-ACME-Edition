//! Well-known DAT IDs for the EnumIDMap / EnumMapper / StringTable
//! lookup tables. Ported verbatim from
//! `external/chorizite/DatReaderWriter.Extensions/DatReaderWriter.Extensions/DBObjs/`
//! `{EnumIDMap,EnumMapper,StringTable}Extensions.cs` (vendored HEAD `ecd759c4`).
//!
//! These constants identify the canonical retail DAT files that act as
//! lookup-table roots — the EnumIDMap entry indexes the EnumMapper IDs, the
//! EnumMapper entries name pre-baked enum tables (Gender, CreatureType,
//! Languages, etc.), and StringTable entries hold localizable string banks.
//!
//! See also `docs/chorizite-reading-guide-summary-2026-05-27.md` §5.7 and
//! `external/chorizite/DatReaderWriter.Extensions/READING_GUIDE.md` §6
//! (PR sketch) for context.
//!
//! Naming convention: C# `PascalCase` -> Rust `SCREAMING_SNAKE_CASE`. The
//! `Undefined = 0` entry from each C# enum is intentionally NOT ported (it is
//! a sentinel, not a real DAT ID; tests assert no constant here is `0`).

/// EnumIDMap entries — generic DAT-ID lookup table maps.
///
/// Ported from `EnumIDMapExtensions.cs:7-29` (22 named entries, all in the
/// `0x25000xxx` range). Each constant points at a retail portal-DAT file that
/// is itself an EnumIDMap whose contents enumerate further IDs.
pub mod enum_id_map {
    /// `EnumMapper` — `EnumIDMapExtensions.cs:8`. Root EnumMapper lookup table.
    pub const ENUM_MAPPER: u32 = 0x25000001;
    /// `UniqueDB` — `EnumIDMapExtensions.cs:9`.
    pub const UNIQUE_DB: u32 = 0x25000002;
    /// `QualityFilters` — `EnumIDMapExtensions.cs:10`.
    pub const QUALITY_FILTERS: u32 = 0x25000003;
    /// `StringTable` — `EnumIDMapExtensions.cs:11`. Root StringTable lookup table.
    pub const STRING_TABLE: u32 = 0x25000004;
    /// `WeenieCategories` — `EnumIDMapExtensions.cs:20`.
    pub const WEENIE_CATEGORIES: u32 = 0x25000005;
    /// `UIAttributeIcons` — `EnumIDMapExtensions.cs:21`.
    pub const UI_ATTRIBUTE_ICONS: u32 = 0x25000006;
    /// `UIAttribute2ndIcons` — `EnumIDMapExtensions.cs:22`.
    pub const UI_ATTRIBUTE_2ND_ICONS: u32 = 0x25000007;
    /// `UIIconBackgrounds` — `EnumIDMapExtensions.cs:23`.
    pub const UI_ICON_BACKGROUNDS: u32 = 0x25000008;
    /// `UIEffectIcons` — `EnumIDMapExtensions.cs:24`.
    pub const UI_EFFECT_ICONS: u32 = 0x25000009;
    /// `UISpellBackgrounds` — `EnumIDMapExtensions.cs:25`.
    pub const UI_SPELL_BACKGROUNDS: u32 = 0x2500000A;
    /// `UISpellOverlays` — `EnumIDMapExtensions.cs:26`.
    pub const UI_SPELL_OVERLAYS: u32 = 0x2500000B;
    /// `CharGenAssets` — `EnumIDMapExtensions.cs:27`.
    pub const CHAR_GEN_ASSETS: u32 = 0x2500000C;
    /// `VividIndicators` — `EnumIDMapExtensions.cs:28`.
    pub const VIVID_INDICATORS: u32 = 0x2500000D;
    /// `UILayout` — `EnumIDMapExtensions.cs:12`.
    pub const UI_LAYOUT: u32 = 0x2500000E;
    /// `UICursor` — `EnumIDMapExtensions.cs:13`.
    pub const UI_CURSOR: u32 = 0x2500000F;
    /// `UIAsset` — `EnumIDMapExtensions.cs:14`.
    pub const UI_ASSET: u32 = 0x25000010;
    /// `ActionMap` — `EnumIDMapExtensions.cs:15`.
    pub const ACTION_MAP: u32 = 0x25000011;
    /// `Font` — `EnumIDMapExtensions.cs:16`.
    pub const FONT: u32 = 0x25000012;
    /// `KeyMap` — `EnumIDMapExtensions.cs:17`.
    pub const KEY_MAP: u32 = 0x25000013;
    /// `Region` — `EnumIDMapExtensions.cs:18`.
    pub const REGION: u32 = 0x25000014;
    /// `WeenieClassId` — `EnumIDMapExtensions.cs:19`.
    pub const WEENIE_CLASS_ID: u32 = 0x25000015;
    /// `WeenieCategories` alias retained for completeness; the canonical
    /// constant is `WEENIE_CATEGORIES` above. Listed here to match the C#
    /// declaration order (line 20). NOTE: not actually a duplicate — the
    /// C# enum lists `WeenieClassId` at line 19 and `WeenieCategories` at
    /// line 20, both unique. This module exports each exactly once.
    ///
    /// Doc-only re-export marker; no real `_DUPLICATE` constant is emitted.
    #[doc(hidden)]
    const _DOC_ANCHOR_NO_DUPLICATES: () = ();
}

/// EnumMapper entries — named pre-baked enum DAT files.
///
/// Ported from `EnumMapperExtensions.cs:6-19` (11 named entries, all in the
/// `0x22000xxx` range). Each constant points at a retail portal-DAT file
/// that is an EnumMapper containing a single enum's id-to-string mapping
/// (e.g. `Gender` maps gender ids to display strings).
pub mod enum_mapper {
    /// `Languages` — `EnumMapperExtensions.cs:9`.
    pub const LANGUAGES: u32 = 0x22000005;
    /// `Gender` — `EnumMapperExtensions.cs:15`.
    pub const GENDER: u32 = 0x2200000A;
    /// `HeritageGroup` — `EnumMapperExtensions.cs:16`.
    pub const HERITAGE_GROUP: u32 = 0x2200000B;
    /// `CreatureType` — `EnumMapperExtensions.cs:17`.
    pub const CREATURE_TYPE: u32 = 0x2200000E;
    /// `MeshTypeId` — `EnumMapperExtensions.cs:8`.
    pub const MESH_TYPE_ID: u32 = 0x22000014;
    /// `TextType` — `EnumMapperExtensions.cs:10`.
    pub const TEXT_TYPE: u32 = 0x2200001F;
    /// `TextTagType` — `EnumMapperExtensions.cs:11`.
    pub const TEXT_TAG_TYPE: u32 = 0x22000020;
    /// `InputActions` — `EnumMapperExtensions.cs:12`.
    pub const INPUT_ACTIONS: u32 = 0x22000021;
    /// `InputMap` — `EnumMapperExtensions.cs:13`.
    pub const INPUT_MAP: u32 = 0x22000022;
    /// `CharacterTitle` — `EnumMapperExtensions.cs:18`. Note: distinct from
    /// the `string_table::CHARACTER_TITLE` entry (`0x2300000E`) which stores
    /// the actual title strings; this one is the id-name mapping.
    pub const CHARACTER_TITLE: u32 = 0x22000041;
    /// `EtherealType` — `EnumMapperExtensions.cs:14`.
    pub const ETHEREAL_TYPE: u32 = 0x22000043;
}

/// StringTable entries — localizable string banks.
///
/// Ported from `StringTableExtensions.cs:6-22` (14 named entries). 13 of these
/// live in the `0x2300xxxx` range; the `LANGUAGE` entry is the lone outlier
/// at `0x41000000`. The READING_GUIDE.md PR sketch (§6) and consolidated
/// summary doc both quote a "13 named entries" figure — that count excludes
/// the outlier `Language`. This module exports all 14 verbatim to match the
/// C# source; tests below assert which range each constant falls into.
pub mod string_table {
    /// `Language` — `StringTableExtensions.cs:8`. Outlier: at `0x41xxxxxx`,
    /// not `0x23xxxxxx` like the rest of this module.
    pub const LANGUAGE: u32 = 0x41000000;
    /// `UI` — `StringTableExtensions.cs:18`.
    pub const UI: u32 = 0x23000001;
    /// `UI_Pregame` — `StringTableExtensions.cs:19`.
    pub const UI_PREGAME: u32 = 0x23000002;
    /// `Preference` — `StringTableExtensions.cs:20`.
    pub const PREFERENCE: u32 = 0x23000003;
    /// `UI_Options` — `StringTableExtensions.cs:21`.
    pub const UI_OPTIONS: u32 = 0x23000004;
    /// `ActionDescription` — `StringTableExtensions.cs:16`.
    pub const ACTION_DESCRIPTION: u32 = 0x23000005;
    /// `Calendar` — `StringTableExtensions.cs:10`.
    pub const CALENDAR: u32 = 0x23000006;
    /// `KeyMap` — `StringTableExtensions.cs:12`.
    pub const KEY_MAP: u32 = 0x23000007;
    /// `KeyNameOverride` — `StringTableExtensions.cs:13`.
    pub const KEY_NAME_OVERRIDE: u32 = 0x2300000A;
    /// `MetakeyNameOverride` — `StringTableExtensions.cs:14`.
    pub const METAKEY_NAME_OVERRIDE: u32 = 0x2300000B;
    /// `CommandSetup` — `StringTableExtensions.cs:15`.
    pub const COMMAND_SETUP: u32 = 0x2300000C;
    /// `Options` — `StringTableExtensions.cs:9`.
    pub const OPTIONS: u32 = 0x2300000D;
    /// `CharacterTitle` — `StringTableExtensions.cs:11`. Holds character-title
    /// strings; see `enum_mapper::CHARACTER_TITLE` for the id-name mapping.
    pub const CHARACTER_TITLE: u32 = 0x2300000E;
    /// `ServerEngine` — `StringTableExtensions.cs:17`.
    pub const SERVER_ENGINE: u32 = 0x23000010;
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------
    // EnumIDMap: 22 named constants, all in 0x25000000..=0x25FFFFFF
    // Cross-reference: EnumIDMapExtensions.cs (vendored HEAD ecd759c4).
    // ------------------------------------------------------------

    #[test]
    fn enum_id_map_constants_match_csharp_source() {
        // line 8
        assert_eq!(enum_id_map::ENUM_MAPPER, 0x25000001);
        // line 9
        assert_eq!(enum_id_map::UNIQUE_DB, 0x25000002);
        // line 10
        assert_eq!(enum_id_map::QUALITY_FILTERS, 0x25000003);
        // line 11
        assert_eq!(enum_id_map::STRING_TABLE, 0x25000004);
        // line 20
        assert_eq!(enum_id_map::WEENIE_CATEGORIES, 0x25000005);
        // line 21
        assert_eq!(enum_id_map::UI_ATTRIBUTE_ICONS, 0x25000006);
        // line 22
        assert_eq!(enum_id_map::UI_ATTRIBUTE_2ND_ICONS, 0x25000007);
        // line 23
        assert_eq!(enum_id_map::UI_ICON_BACKGROUNDS, 0x25000008);
        // line 24
        assert_eq!(enum_id_map::UI_EFFECT_ICONS, 0x25000009);
        // line 25
        assert_eq!(enum_id_map::UI_SPELL_BACKGROUNDS, 0x2500000A);
        // line 26
        assert_eq!(enum_id_map::UI_SPELL_OVERLAYS, 0x2500000B);
        // line 27
        assert_eq!(enum_id_map::CHAR_GEN_ASSETS, 0x2500000C);
        // line 28
        assert_eq!(enum_id_map::VIVID_INDICATORS, 0x2500000D);
        // line 12
        assert_eq!(enum_id_map::UI_LAYOUT, 0x2500000E);
        // line 13
        assert_eq!(enum_id_map::UI_CURSOR, 0x2500000F);
        // line 14
        assert_eq!(enum_id_map::UI_ASSET, 0x25000010);
        // line 15
        assert_eq!(enum_id_map::ACTION_MAP, 0x25000011);
        // line 16
        assert_eq!(enum_id_map::FONT, 0x25000012);
        // line 17
        assert_eq!(enum_id_map::KEY_MAP, 0x25000013);
        // line 18
        assert_eq!(enum_id_map::REGION, 0x25000014);
        // line 19
        assert_eq!(enum_id_map::WEENIE_CLASS_ID, 0x25000015);
    }

    #[test]
    fn enum_id_map_all_within_0x25xxxxxx_range() {
        const RANGE: std::ops::RangeInclusive<u32> = 0x25000000..=0x25FFFFFF;
        let all: &[u32] = &[
            enum_id_map::ENUM_MAPPER,
            enum_id_map::UNIQUE_DB,
            enum_id_map::QUALITY_FILTERS,
            enum_id_map::STRING_TABLE,
            enum_id_map::WEENIE_CATEGORIES,
            enum_id_map::UI_ATTRIBUTE_ICONS,
            enum_id_map::UI_ATTRIBUTE_2ND_ICONS,
            enum_id_map::UI_ICON_BACKGROUNDS,
            enum_id_map::UI_EFFECT_ICONS,
            enum_id_map::UI_SPELL_BACKGROUNDS,
            enum_id_map::UI_SPELL_OVERLAYS,
            enum_id_map::CHAR_GEN_ASSETS,
            enum_id_map::VIVID_INDICATORS,
            enum_id_map::UI_LAYOUT,
            enum_id_map::UI_CURSOR,
            enum_id_map::UI_ASSET,
            enum_id_map::ACTION_MAP,
            enum_id_map::FONT,
            enum_id_map::KEY_MAP,
            enum_id_map::REGION,
            enum_id_map::WEENIE_CLASS_ID,
        ];
        assert_eq!(all.len(), 21, "expected 21 unique EnumIDMap entries");
        for &id in all {
            assert!(
                RANGE.contains(&id),
                "EnumIDMap constant {:#010X} outside 0x25xxxxxx range",
                id
            );
        }
    }

    // ------------------------------------------------------------
    // EnumMapper: 11 named constants, all in 0x22000000..=0x22FFFFFF
    // Cross-reference: EnumMapperExtensions.cs (vendored HEAD ecd759c4).
    // ------------------------------------------------------------

    #[test]
    fn enum_mapper_constants_match_csharp_source() {
        assert_eq!(enum_mapper::LANGUAGES, 0x22000005);           // line 9
        assert_eq!(enum_mapper::GENDER, 0x2200000A);              // line 15
        assert_eq!(enum_mapper::HERITAGE_GROUP, 0x2200000B);      // line 16
        assert_eq!(enum_mapper::CREATURE_TYPE, 0x2200000E);       // line 17
        assert_eq!(enum_mapper::MESH_TYPE_ID, 0x22000014);        // line 8
        assert_eq!(enum_mapper::TEXT_TYPE, 0x2200001F);           // line 10
        assert_eq!(enum_mapper::TEXT_TAG_TYPE, 0x22000020);       // line 11
        assert_eq!(enum_mapper::INPUT_ACTIONS, 0x22000021);       // line 12
        assert_eq!(enum_mapper::INPUT_MAP, 0x22000022);           // line 13
        assert_eq!(enum_mapper::CHARACTER_TITLE, 0x22000041);     // line 18
        assert_eq!(enum_mapper::ETHEREAL_TYPE, 0x22000043);       // line 14
    }

    #[test]
    fn enum_mapper_all_within_0x22xxxxxx_range() {
        const RANGE: std::ops::RangeInclusive<u32> = 0x22000000..=0x22FFFFFF;
        let all: &[u32] = &[
            enum_mapper::LANGUAGES,
            enum_mapper::GENDER,
            enum_mapper::HERITAGE_GROUP,
            enum_mapper::CREATURE_TYPE,
            enum_mapper::MESH_TYPE_ID,
            enum_mapper::TEXT_TYPE,
            enum_mapper::TEXT_TAG_TYPE,
            enum_mapper::INPUT_ACTIONS,
            enum_mapper::INPUT_MAP,
            enum_mapper::CHARACTER_TITLE,
            enum_mapper::ETHEREAL_TYPE,
        ];
        assert_eq!(all.len(), 11, "expected 11 unique EnumMapper entries");
        for &id in all {
            assert!(
                RANGE.contains(&id),
                "EnumMapper constant {:#010X} outside 0x22xxxxxx range",
                id
            );
        }
    }

    // ------------------------------------------------------------
    // StringTable: 14 named constants. 13 sit in 0x23000000..=0x23FFFFFF;
    // the LANGUAGE outlier sits at 0x41000000.
    // Cross-reference: StringTableExtensions.cs (vendored HEAD ecd759c4).
    // ------------------------------------------------------------

    #[test]
    fn string_table_constants_match_csharp_source() {
        assert_eq!(string_table::LANGUAGE, 0x41000000);                 // line 8
        assert_eq!(string_table::UI, 0x23000001);                       // line 18
        assert_eq!(string_table::UI_PREGAME, 0x23000002);               // line 19
        assert_eq!(string_table::PREFERENCE, 0x23000003);               // line 20
        assert_eq!(string_table::UI_OPTIONS, 0x23000004);               // line 21
        assert_eq!(string_table::ACTION_DESCRIPTION, 0x23000005);       // line 16
        assert_eq!(string_table::CALENDAR, 0x23000006);                 // line 10
        assert_eq!(string_table::KEY_MAP, 0x23000007);                  // line 12
        assert_eq!(string_table::KEY_NAME_OVERRIDE, 0x2300000A);        // line 13
        assert_eq!(string_table::METAKEY_NAME_OVERRIDE, 0x2300000B);    // line 14
        assert_eq!(string_table::COMMAND_SETUP, 0x2300000C);            // line 15
        assert_eq!(string_table::OPTIONS, 0x2300000D);                  // line 9
        assert_eq!(string_table::CHARACTER_TITLE, 0x2300000E);          // line 11
        assert_eq!(string_table::SERVER_ENGINE, 0x23000010);            // line 17
    }

    #[test]
    fn string_table_main_block_within_0x23xxxxxx_range() {
        // All entries EXCEPT LANGUAGE live in 0x23xxxxxx.
        const RANGE: std::ops::RangeInclusive<u32> = 0x23000000..=0x23FFFFFF;
        let main_block: &[u32] = &[
            string_table::UI,
            string_table::UI_PREGAME,
            string_table::PREFERENCE,
            string_table::UI_OPTIONS,
            string_table::ACTION_DESCRIPTION,
            string_table::CALENDAR,
            string_table::KEY_MAP,
            string_table::KEY_NAME_OVERRIDE,
            string_table::METAKEY_NAME_OVERRIDE,
            string_table::COMMAND_SETUP,
            string_table::OPTIONS,
            string_table::CHARACTER_TITLE,
            string_table::SERVER_ENGINE,
        ];
        assert_eq!(main_block.len(), 13, "expected 13 entries in the 0x23xxxxxx block");
        for &id in main_block {
            assert!(
                RANGE.contains(&id),
                "StringTable main-block constant {:#010X} outside 0x23xxxxxx range",
                id
            );
        }
    }

    #[test]
    fn string_table_language_outlier_at_0x41000000() {
        // Documents the load-bearing oddity: the LANGUAGE entry is the
        // only one not in the 0x23xxxxxx block. Verbatim from C# source
        // line 8: `Language = 0x41000000`. The READING_GUIDE.md tally of
        // "13 entries at 0x23xxxxxx" excludes this; we ship it anyway.
        assert_eq!(string_table::LANGUAGE, 0x41000000);
        assert!(
            !(0x23000000..=0x23FFFFFF).contains(&string_table::LANGUAGE),
            "LANGUAGE constant unexpectedly fell inside the 0x23xxxxxx block"
        );
    }

    // ------------------------------------------------------------
    // Sanity: no constant equals the C# `Undefined = 0` sentinel.
    // ------------------------------------------------------------

    #[test]
    fn no_constant_is_zero_sentinel() {
        // EnumIDMap
        let id_map: &[u32] = &[
            enum_id_map::ENUM_MAPPER,
            enum_id_map::UNIQUE_DB,
            enum_id_map::QUALITY_FILTERS,
            enum_id_map::STRING_TABLE,
            enum_id_map::WEENIE_CATEGORIES,
            enum_id_map::UI_ATTRIBUTE_ICONS,
            enum_id_map::UI_ATTRIBUTE_2ND_ICONS,
            enum_id_map::UI_ICON_BACKGROUNDS,
            enum_id_map::UI_EFFECT_ICONS,
            enum_id_map::UI_SPELL_BACKGROUNDS,
            enum_id_map::UI_SPELL_OVERLAYS,
            enum_id_map::CHAR_GEN_ASSETS,
            enum_id_map::VIVID_INDICATORS,
            enum_id_map::UI_LAYOUT,
            enum_id_map::UI_CURSOR,
            enum_id_map::UI_ASSET,
            enum_id_map::ACTION_MAP,
            enum_id_map::FONT,
            enum_id_map::KEY_MAP,
            enum_id_map::REGION,
            enum_id_map::WEENIE_CLASS_ID,
        ];
        for &id in id_map {
            assert_ne!(id, 0, "EnumIDMap constant must not be the Undefined sentinel");
        }

        // EnumMapper
        let mapper: &[u32] = &[
            enum_mapper::LANGUAGES,
            enum_mapper::GENDER,
            enum_mapper::HERITAGE_GROUP,
            enum_mapper::CREATURE_TYPE,
            enum_mapper::MESH_TYPE_ID,
            enum_mapper::TEXT_TYPE,
            enum_mapper::TEXT_TAG_TYPE,
            enum_mapper::INPUT_ACTIONS,
            enum_mapper::INPUT_MAP,
            enum_mapper::CHARACTER_TITLE,
            enum_mapper::ETHEREAL_TYPE,
        ];
        for &id in mapper {
            assert_ne!(id, 0, "EnumMapper constant must not be the Undefined sentinel");
        }

        // StringTable
        let strings: &[u32] = &[
            string_table::LANGUAGE,
            string_table::UI,
            string_table::UI_PREGAME,
            string_table::PREFERENCE,
            string_table::UI_OPTIONS,
            string_table::ACTION_DESCRIPTION,
            string_table::CALENDAR,
            string_table::KEY_MAP,
            string_table::KEY_NAME_OVERRIDE,
            string_table::METAKEY_NAME_OVERRIDE,
            string_table::COMMAND_SETUP,
            string_table::OPTIONS,
            string_table::CHARACTER_TITLE,
            string_table::SERVER_ENGINE,
        ];
        for &id in strings {
            assert_ne!(id, 0, "StringTable constant must not be the Undefined sentinel");
        }
    }

    // ------------------------------------------------------------
    // Cross-module: EnumMapper::CHARACTER_TITLE != StringTable::CHARACTER_TITLE.
    // Both are valid retail IDs but live in different namespaces and serve
    // different purposes. Guard against accidental cross-module copy/paste.
    // ------------------------------------------------------------

    #[test]
    fn character_title_constants_are_distinct_across_modules() {
        assert_ne!(
            enum_mapper::CHARACTER_TITLE,
            string_table::CHARACTER_TITLE,
            "enum_mapper::CHARACTER_TITLE (the id-name map) must not collide \
             with string_table::CHARACTER_TITLE (the title-text store)"
        );
        // Sanity: enum_mapper one is 0x22xxxxxx, string_table one is 0x23xxxxxx.
        assert_eq!(enum_mapper::CHARACTER_TITLE & 0xFF000000, 0x22000000);
        assert_eq!(string_table::CHARACTER_TITLE & 0xFF000000, 0x23000000);
    }

    // ------------------------------------------------------------
    // KEY_MAP exists in BOTH enum_id_map (0x25000013) and string_table
    // (0x23000007). These are two different DAT files; this test asserts
    // the values stay distinct.
    // ------------------------------------------------------------

    #[test]
    fn key_map_constants_are_distinct_across_modules() {
        assert_eq!(enum_id_map::KEY_MAP, 0x25000013);
        assert_eq!(string_table::KEY_MAP, 0x23000007);
        assert_ne!(enum_id_map::KEY_MAP, string_table::KEY_MAP);
    }
}
