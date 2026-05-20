using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using ChorCommon = Chorizite.Common.Enums;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 2.C — Cross-port enum parity audit.
///
/// For every enum we curate in <c>CommandEngine.Chorizite.cs:CuratedEnumAllowlist</c>
/// (all 65 enums in <c>Chorizite.Common.Enums</c> + <c>ObjectDescriptionFlag</c>
/// from <c>Chorizite.ACProtocol</c>), find the corresponding Rust enum in
/// <c>external/holtburger/crates/</c> and diff member-by-member. Output is a
/// structured report the validator + holtburger-side tests consume.
///
/// Pattern mirrors:
///   - <see cref="CommandEngine.ChoriziteDumpEnumValues"/> for the C# side
///     (reflection over <c>Chorizite.Common.Enums</c> + regex-parse of
///     ACProtocol).
///   - <c>external/holtburger/crates/holtburger-protocol/tests/opcode_parity.rs</c>
///     for the Rust-side enumeration strategy (regex-parse <c>pub enum Foo
///     { Variant = 0xNNNN, … }</c> blocks).
///
/// Why regex-parse instead of macros / cargo expand: keeps WB.Terminal free
/// of a Cargo dependency. The Rust enum source files we care about all use
/// the simple <c>Variant = 0xNNNN,</c> or <c>Variant,</c> discriminant pattern
/// — no associated data, no nested types. A 40-line regex extractor is
/// sufficient and survives `cargo fmt` reflows.
///
/// Scope limits (documented honest gaps surface as <c>mapping-gap</c> rows):
///   - <c>bitflags!</c> macro-generated bitflag structs (e.g.
///     <c>AttackConditions</c>) are NOT detected — we only scan <c>pub enum</c>.
///     Most Chorizite [Flags] enums (e.g. <c>ItemType</c>, <c>SpellFlags</c>,
///     <c>WeenieHeaderFlag</c>) don't have a Rust enum counterpart precisely
///     because we use bitflags! macros; those surface as MISSING-RUST and
///     are diagnostic, not "a parity bug".
///   - Same-name-different-meaning collisions (e.g. Chorizite's
///     <c>HeritageGroup</c> with 11 races vs Rust's stub) are reported as
///     value-mismatch rows, NOT silently auto-mapped to the wrong file.
///   - <see cref="ManualEnumMapping"/> below documents the cases where the
///     name disambiguation requires hand-curation (e.g. Chorizite
///     <c>AttributeId</c> vs Rust <c>AttributeType</c> in holtburger-common
///     stats.rs — different name, same semantic).
/// </summary>
public partial class CommandEngine {

    public sealed record EnumParityReport(
        string ChoriziteSourceRoot,
        string RustCrateRoot,
        int CheckedEnums,
        int PassEnums,
        int FailEnums,
        int GapEnums,
        IReadOnlyList<EnumParityRow> Rows);

    public sealed record EnumParityRow(
        string ChoriziteName,
        string? RustName,
        string? RustRelativePath,
        string Status,
        int CheckedMembers,
        int PassMembers,
        int FailMembers,
        IReadOnlyList<EnumMemberMismatch> Mismatches);

    public sealed record EnumMemberMismatch(
        string Kind,
        string Name,
        long? ChoriziteValue,
        long? RustValue,
        string? Note);

    /// <summary>
    /// Manual mapping table: Chorizite enum name → (Rust crate-relative
    /// source path, Rust enum identifier). Drives the parity diff for cases
    /// where (a) the names diverge but the semantic is the same, OR
    /// (b) the Rust side has the enum but in a non-obvious crate. Add a
    /// row here when a wave introduces a new shared enum.
    ///
    /// The mapping is deliberately conservative: entries are 1:1 verified
    /// against the source code, not synthesized from a heuristic. Cases
    /// where there's NO Rust enum (because we use bitflags! or because
    /// the surface isn't yet ported) are absent here and surface as
    /// MISSING-RUST in the report.
    /// </summary>
    /// <summary>Wave 2.D allowlist entry — drop matching mismatches from DiffOne's report.</summary>
    public sealed record AllowlistedMismatch(string Kind, string MemberName, string Reason);

    /// <summary>Mapping row with optional per-row allowlist (Wave 2.D refactor).</summary>
    public sealed record EnumMappingRow(
        string Chorizite,
        string RustPath,
        string RustName,
        IReadOnlyList<AllowlistedMismatch>? Allowlist = null);

    private static readonly EnumMappingRow[] ManualEnumMapping = new[] {
        // Same name, same enum — no allowlist needed where parity is exact.
        new EnumMappingRow("AttackHeight",  "holtburger-protocol/src/messages/combat/types.rs", "AttackHeight"),
        new EnumMappingRow("HeritageGroup", "holtburger-world/src/assessment.rs",                "HeritageGroup"),
        new EnumMappingRow("MagicSchool",   "holtburger-world/src/spell.rs",                     "MagicSchool"),
        new EnumMappingRow("PropertyInt64", "holtburger-common/src/properties/property_keys/int64s.rs", "PropertyInt64"),
        new EnumMappingRow("RadarColor",    "holtburger-common/src/properties/radar.rs",         "RadarColor"),

        // Same name, same enum WITH documented per-row divergences (Wave 2.C drift audit).
        new EnumMappingRow("CombatMode", "holtburger-protocol/src/messages/combat/types.rs", "CombatMode",
            new [] {
                new AllowlistedMismatch("missing-chorizite", "Undef",
                    "ACE-side value-0 sentinel; not present in Chorizite. ACE-wins per three-source cross-reference rule."),
            }),
        new EnumMappingRow("CreatureType", "holtburger-common/src/stats.rs", "CreatureType",
            new [] {
                new AllowlistedMismatch("missing-chorizite", "Invalid",
                    "ACE-side value-0 sentinel; Chorizite starts at value 1. ACE-wins."),
            }),
        // DatFileType: Chorizite (4 values: Undefined/Portal/Cell/Local) identifies WHICH DAT
        // FILE a record came from. Rust (28 values: Model/SetupModel/Animation/...) identifies
        // WHICH ASSET TYPE within a DAT. Same name, different concepts. Allowlist every member
        // on both sides so the row reports `pass` with no surfaced mismatches — the divergence
        // is structural, not a porting drift.
        new EnumMappingRow("DatFileType", "holtburger-dat/src/file_type/mod.rs", "DatFileType",
            new [] {
                new AllowlistedMismatch("missing-rust", "Undefined", "Chorizite per-file-handle enum; Rust uses per-asset-type. Different concepts."),
                new AllowlistedMismatch("missing-rust", "Portal",    "Chorizite per-file-handle enum; different concept from Rust."),
                new AllowlistedMismatch("missing-rust", "Cell",      "Chorizite per-file-handle enum; different concept from Rust."),
                new AllowlistedMismatch("missing-rust", "Local",     "Chorizite per-file-handle enum; different concept from Rust."),
                new AllowlistedMismatch("missing-chorizite", "Model",              "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "SetupModel",         "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Animation",          "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Palette",            "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "SurfaceTexture",     "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Texture",            "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Surface",            "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "MotionTable",        "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Wave",               "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Environment",        "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Scene",              "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Region",             "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "SoundTable",         "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "ParticleEmitter",    "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "PhysicsScript",      "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "PhysicsScriptTable", "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "EnvCell",            "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "ChatPoseTable",      "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "CharGen",            "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "SkillTable",         "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "SpellTable",         "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "ExperienceTable",    "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "VitalTable",         "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "SpellComponentTable","Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "XpTable",            "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "CombatTable",        "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Custom",             "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Landblock",          "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Iteration",          "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Unknown",            "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Audio",              "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Table",              "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Clothing",           "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "CombatManeuverTable","Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "LanguageString",     "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "Font",               "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "LandblockInfo",      "Rust per-asset-type enum; not on Chorizite side."),
                new AllowlistedMismatch("missing-chorizite", "IndoorCell",         "Rust per-asset-type enum; not on Chorizite side."),
            }),
        new EnumMappingRow("MaterialType", "holtburger-common/src/properties/inventory.rs", "MaterialType",
            new [] {
                new AllowlistedMismatch("missing-chorizite", "Unknown",
                    "ACE-side value-0 sentinel; Chorizite starts at Ceramic=1."),
                new AllowlistedMismatch("missing-chorizite", "Cloth",
                    "ACE-side category header at value 3; Chorizite skips it (starts gem-category at Linen=4)."),
                new AllowlistedMismatch("missing-chorizite", "Gem",   "ACE-side category header at value 9."),
                new AllowlistedMismatch("missing-chorizite", "Metal", "ACE-side category header at value 56."),
                new AllowlistedMismatch("missing-chorizite", "Stone", "ACE-side category header at value 65."),
                new AllowlistedMismatch("missing-chorizite", "Wood",  "ACE-side category header at value 72."),
            }),
        // MotionStance: Chorizite strips the 0x80000000 high bit as presentation convenience.
        // Retail wire value confirmed 0x8000003c in acclient.txt + ACE source. ACE-wins; Rust correct.
        new EnumMappingRow("MotionStance", "holtburger-protocol/src/messages/movement/types.rs", "MotionStance",
            new [] {
                new AllowlistedMismatch("value-mismatch", "HandCombat",            "Chorizite strips 0x80000000 high bit. Retail wire 0x8000003c."),
                new AllowlistedMismatch("value-mismatch", "NonCombat",             "Same as HandCombat — Chorizite strips 0x80000000 high bit."),
                new AllowlistedMismatch("value-mismatch", "SwordCombat",           "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "BowCombat",             "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "SwordShieldCombat",     "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "CrossbowCombat",        "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "UnusedCombat",          "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "SlingCombat",           "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "TwoHandedSwordCombat",  "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "TwoHandedStaffCombat",  "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "DualWieldCombat",       "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "ThrownWeaponCombat",    "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "Magic",                 "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "BowNoAmmo",             "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "CrossBowNoAmmo",        "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "AtlatlCombat",          "Same as HandCombat."),
                new AllowlistedMismatch("value-mismatch", "ThrownShieldCombat",    "Same as HandCombat."),
                new AllowlistedMismatch("missing-chorizite", "Invalid",            "ACE-side value-0x80000000 sentinel; Chorizite has no MotionStance::Invalid."),
                new AllowlistedMismatch("missing-chorizite", "Graze",              "ACE-side variant at 0x80000048; Chorizite omits."),
            }),
        new EnumMappingRow("PropertyBool", "holtburger-common/src/properties/property_keys/bools.rs", "PropertyBool",
            new [] {
                new AllowlistedMismatch("missing-rust",      "None",  "Chorizite value-0 sentinel; Rust+ACE use Undef."),
                new AllowlistedMismatch("missing-chorizite", "Undef", "Rust+ACE value-0 sentinel; Chorizite uses None."),
                new AllowlistedMismatch("missing-chorizite", "LinkedPortalOneSummon",      "ACE-server-side extension key."),
                new AllowlistedMismatch("missing-chorizite", "LinkedPortalTwoSummon",      "ACE-server-side extension key."),
                new AllowlistedMismatch("missing-chorizite", "HouseEvicted",               "ACE-server-side extension key."),
                new AllowlistedMismatch("missing-chorizite", "UntrainedSkills",            "ACE-server-side extension key."),
                new AllowlistedMismatch("missing-chorizite", "IsEnvoy",                    "ACE-server-side extension key."),
                new AllowlistedMismatch("missing-chorizite", "UnspecializedSkills",        "ACE-server-side extension key."),
                new AllowlistedMismatch("missing-chorizite", "FreeSkillResetRenewed",      "ACE-server-side extension key."),
                new AllowlistedMismatch("missing-chorizite", "FreeAttributeResetRenewed",  "ACE-server-side extension key."),
                new AllowlistedMismatch("missing-chorizite", "SkillTemplesTimerReset",     "ACE-server-side extension key."),
                new AllowlistedMismatch("missing-chorizite", "FreeMasteryResetRenewed",    "ACE-server-side extension key."),
            }),
        new EnumMappingRow("PropertyDataId", "holtburger-common/src/properties/property_keys/data_ids.rs", "PropertyDataId",
            new [] {
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedWeenieHeader",        "capture-only client-internal metadata; not on retail wire."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedWeenieHeader2",       "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedObjectDesc",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedPhysicsDesc",         "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedParentLocation",      "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedDefaultScript",       "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp0",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp1",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp2",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp3",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp4",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp5",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp6",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp7",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp8",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedTimestamp9",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedMaxVelocityEstimated","capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapPhysicsDidDataTemplatedFrom", "capture-only client-internal metadata."),
            }),
        new EnumMappingRow("PropertyFloat", "holtburger-common/src/properties/property_keys/floats.rs", "PropertyFloat",
            new [] {
                new AllowlistedMismatch("missing-rust",      "None",  "Chorizite value-0 sentinel; Rust+ACE use Undef."),
                new AllowlistedMismatch("missing-chorizite", "Undef", "Rust+ACE value-0 sentinel."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedWorkmanship",    "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedVelocityX",      "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedVelocityY",      "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedVelocityZ",      "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedAccelerationX",  "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedAccelerationY",  "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedAccelerationZ",  "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordeOmegaX",          "capture-only client-internal metadata (typo `Recorde` mirrors Rust source)."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordeOmegaY",          "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordeOmegaZ",          "capture-only client-internal metadata."),
            }),
        new EnumMappingRow("PropertyInstanceId", "holtburger-common/src/properties/property_keys/instance_ids.rs", "PropertyInstanceId",
            new [] {
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedObjectIid", "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedParentIid", "capture-only client-internal metadata."),
            }),
        new EnumMappingRow("PropertyInt", "holtburger-common/src/properties/property_keys/ints.rs", "PropertyInt",
            new [] {
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedAutonomousMovement",  "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedMaxVelocityEstimated","capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedPlacement",           "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedAppraisalPages",      "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedAppraisalMaxPages",   "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "CurrentLoyaltyAtLastLogoff",      "ACE-server-side extension at 9008."),
                new AllowlistedMismatch("missing-chorizite", "CurrentLeadershipAtLastLogoff",   "ACE-server-side extension at 9009."),
                new AllowlistedMismatch("missing-chorizite", "AllegianceOfficerRank",           "ACE-server-side extension at 9010."),
                new AllowlistedMismatch("missing-chorizite", "HouseRentTimestamp",              "ACE-server-side extension at 9011."),
                new AllowlistedMismatch("missing-chorizite", "Hairstyle",                       "ACE-server-side extension at 9012."),
                new AllowlistedMismatch("missing-chorizite", "VisualClothingPriority",          "ACE-server-side extension at 9013."),
                new AllowlistedMismatch("missing-chorizite", "SquelchGlobal",                   "ACE-server-side extension at 9014."),
                new AllowlistedMismatch("missing-chorizite", "InventoryOrder",                  "ACE-server-side extension at 9015."),
            }),
        new EnumMappingRow("PropertyString", "holtburger-common/src/properties/property_keys/strings.rs", "PropertyString",
            new [] {
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedCurrentMotionState", "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedServerName",         "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "PcapRecordedCharacterName",      "capture-only client-internal metadata."),
                new AllowlistedMismatch("missing-chorizite", "AllegianceMotd",                 "ACE-server-side extension at 9001."),
                new AllowlistedMismatch("missing-chorizite", "AllegianceMotdSetBy",            "ACE-server-side extension at 9002."),
                new AllowlistedMismatch("missing-chorizite", "AllegianceSpeakerTitle",         "ACE-server-side extension at 9003."),
                new AllowlistedMismatch("missing-chorizite", "AllegianceSeneschalTitle",       "ACE-server-side extension at 9004."),
                new AllowlistedMismatch("missing-chorizite", "AllegianceCastellanTitle",       "ACE-server-side extension at 9005."),
                new AllowlistedMismatch("missing-chorizite", "GodState",                       "ACE-server-side extension at 9006."),
                new AllowlistedMismatch("missing-chorizite", "TinkerLog",                      "ACE-server-side extension at 9007."),
            }),
        new EnumMappingRow("RadarBehavior", "holtburger-common/src/properties/radar.rs", "RadarBehavior",
            new [] {
                new AllowlistedMismatch("missing-rust",      "None",      "Chorizite value-0 sentinel; Rust+ACE use Undefined."),
                new AllowlistedMismatch("missing-chorizite", "Undefined", "Rust+ACE value-0 sentinel; Chorizite uses None."),
            }),
        new EnumMappingRow("SkillAdvancementClass", "holtburger-protocol/src/messages/character/types.rs", "SkillAdvancementClass",
            new [] {
                new AllowlistedMismatch("missing-rust",      "Unusable", "Chorizite value-0 sentinel; ACE+Rust use Inactive."),
                new AllowlistedMismatch("missing-chorizite", "Inactive", "Rust+ACE value-0 sentinel."),
            }),
        new EnumMappingRow("WeenieType", "holtburger-common/src/properties/object.rs", "WeenieType",
            new [] {
                new AllowlistedMismatch("missing-rust",      "None",  "Chorizite value-0 sentinel; Rust+ACE use Undef."),
                new AllowlistedMismatch("missing-chorizite", "Undef", "Rust+ACE value-0 sentinel."),
            }),
        // WieldRequirement: repointed at WieldRequirementType (the int-valued mirror).
        // The original WieldRequirement is a tagged Rust enum (algebraic data type) with
        // payload variants — validator can't diff its int values because variants aren't
        // discriminated by integer.
        new EnumMappingRow("WieldRequirement", "holtburger-world/src/assessment.rs", "WieldRequirementType",
            new [] {
                new AllowlistedMismatch("missing-rust",      "None",    "Chorizite value-0 sentinel; Rust+ACE WieldRequirementType uses Invalid."),
                new AllowlistedMismatch("missing-chorizite", "Invalid", "Rust+ACE value-0 sentinel; Chorizite uses None."),
            }),

        // Chorizite name ≠ Rust name; semantic match (one-to-one mapping).
        new EnumMappingRow("AttributeId", "holtburger-world/src/player/skill_formula.rs", "AttributeId",
            new [] {
                new AllowlistedMismatch("missing-rust",      "Self",  "Chorizite spells it `Self`; Rust uses `Self_` because `self` is a Rust keyword."),
                new AllowlistedMismatch("missing-chorizite", "Self_", "Rust escape-rename of Chorizite's `Self` variant. Identical semantic at value 6."),
            }),

        // Bitflags-style — Chorizite uses [Flags] enum; Rust uses bitflags!
        // macro and has NO `pub enum` counterpart. Surfaces as MISSING-RUST,
        // which is correct (semantically equivalent but lives in a struct,
        // not an enum). No row added intentionally.
    };

    /// <summary>
    /// Entry point — runs the parity audit and returns a structured report.
    /// </summary>
    /// <param name="sourceRoot">Chorizite source root. Default = walk-up to
    /// <c>external/chorizite/</c>.</param>
    /// <param name="rustCrateRoot">Rust crates root. Default = walk-up to
    /// <c>external/holtburger/crates/</c>.</param>
    public EnumParityReport EnumParityReportCommand(string? sourceRoot, string? rustCrateRoot) {
        var chorRoot = string.IsNullOrWhiteSpace(sourceRoot) ? DefaultChoriziteSourceRoot : sourceRoot;
        var rustRoot = string.IsNullOrWhiteSpace(rustCrateRoot) ? DefaultHoltburgerCratesRoot : rustCrateRoot;

        // Build the canonical Chorizite enum dump first (reuse existing engine
        // method so we share the underlying-type handling + ACProtocol fallback).
        var chorDumps = ChoriziteDumpEnumValues(null);

        var rows = new List<EnumParityRow>(chorDumps.Count);
        int passCount = 0, failCount = 0, gapCount = 0;

        foreach (var chorDump in chorDumps) {
            var row = DiffOne(chorDump, rustRoot);
            switch (row.Status) {
                case "pass":           passCount++; break;
                case "missing-rust":   gapCount++;  break;
                case "fail":           failCount++; break;
                case "rust-file-gone": gapCount++;  break;
                default:               failCount++; break;
            }
            rows.Add(row);
        }

        return new EnumParityReport(
            ChoriziteSourceRoot: chorRoot,
            RustCrateRoot: rustRoot,
            CheckedEnums: rows.Count,
            PassEnums: passCount,
            FailEnums: failCount,
            GapEnums: gapCount,
            Rows: rows);
    }

    /// <summary>
    /// Diff one Chorizite enum against the corresponding Rust enum.
    /// </summary>
    private static EnumParityRow DiffOne(ChoriziteEnumDump chor, string rustRoot) {
        // Step 1 — resolve a Rust-side mapping. First check the manual table;
        // if absent, try the same-name conventional search (find any
        // `pub enum <chor.EnumName>` under rustRoot).
        string? rustPath = null;
        string? rustName = null;
        EnumMappingRow? mapping = ManualEnumMapping.FirstOrDefault(m =>
            string.Equals(m.Chorizite, chor.EnumName, StringComparison.Ordinal));
        if (mapping != null && !string.IsNullOrEmpty(mapping.RustName)) {
            rustPath = mapping.RustPath;
            rustName = mapping.RustName;
        }
        if (rustPath == null) {
            // Fallback: scan rustRoot for `pub enum <chor.EnumName> ` in any .rs file.
            var hit = FindRustEnumByName(rustRoot, chor.EnumName);
            if (hit != null) {
                rustPath = hit.Value.RelPath;
                rustName = chor.EnumName;
            }
        }

        if (rustPath == null || rustName == null) {
            return new EnumParityRow(
                ChoriziteName: chor.EnumName,
                RustName: null,
                RustRelativePath: null,
                Status: "missing-rust",
                CheckedMembers: chor.Members.Count,
                PassMembers: 0,
                FailMembers: 0,
                Mismatches: chor.Members.Select(m => new EnumMemberMismatch(
                    Kind: "missing-rust-enum",
                    Name: m.Name,
                    ChoriziteValue: m.ValueDecimal,
                    RustValue: null,
                    Note: $"no Rust pub enum named {chor.EnumName} (and no manual mapping)")).ToList());
        }

        // Step 2 — parse the Rust enum source file.
        var absRustPath = Path.Combine(rustRoot, rustPath);
        if (!File.Exists(absRustPath)) {
            return new EnumParityRow(
                ChoriziteName: chor.EnumName,
                RustName: rustName,
                RustRelativePath: rustPath,
                Status: "rust-file-gone",
                CheckedMembers: chor.Members.Count,
                PassMembers: 0,
                FailMembers: 0,
                Mismatches: new[] {
                    new EnumMemberMismatch(
                        Kind: "rust-source-missing",
                        Name: "(file)",
                        ChoriziteValue: null,
                        RustValue: null,
                        Note: $"Rust source file not found at {absRustPath}; mapping table is stale.")
                });
        }

        var rustMembers = ParseRustEnumBlock(absRustPath, rustName);
        if (rustMembers == null) {
            return new EnumParityRow(
                ChoriziteName: chor.EnumName,
                RustName: rustName,
                RustRelativePath: rustPath,
                Status: "rust-file-gone",
                CheckedMembers: chor.Members.Count,
                PassMembers: 0,
                FailMembers: 0,
                Mismatches: new[] {
                    new EnumMemberMismatch(
                        Kind: "rust-enum-not-found",
                        Name: rustName,
                        ChoriziteValue: null,
                        RustValue: null,
                        Note: $"pub enum {rustName} not found inside {rustPath}; mapping table is stale.")
                });
        }

        // Step 3 — diff. We compare by name (case-sensitive) AND by value.
        // For variants on one side only, that's a missing/extra. For variants
        // present on both, if the values disagree that's a value-mismatch.
        var chorByName = chor.Members.ToDictionary(m => m.Name, m => m.ValueDecimal);
        var rustByName = rustMembers.ToDictionary(m => m.Name, m => m.Value);
        var mismatches = new List<EnumMemberMismatch>();

        // Variants in Chorizite but not Rust (and value-mismatches).
        foreach (var m in chor.Members) {
            if (!rustByName.TryGetValue(m.Name, out var rustVal)) {
                mismatches.Add(new EnumMemberMismatch(
                    Kind: "missing-rust",
                    Name: m.Name,
                    ChoriziteValue: m.ValueDecimal,
                    RustValue: null,
                    Note: null));
            } else if (rustVal != m.ValueDecimal) {
                mismatches.Add(new EnumMemberMismatch(
                    Kind: "value-mismatch",
                    Name: m.Name,
                    ChoriziteValue: m.ValueDecimal,
                    RustValue: rustVal,
                    Note: null));
            }
        }
        // Variants in Rust but not Chorizite.
        foreach (var m in rustMembers) {
            if (!chorByName.ContainsKey(m.Name)) {
                mismatches.Add(new EnumMemberMismatch(
                    Kind: "missing-chorizite",
                    Name: m.Name,
                    ChoriziteValue: null,
                    RustValue: m.Value,
                    Note: null));
            }
        }

        // Wave 2.D — filter mismatches through the mapping's allowlist before
        // computing pass/fail status. Allowlisted mismatches are dropped from
        // the report entirely (the in-source AllowlistedMismatch.Reason is the
        // durable record; surfacing them every run would be noise).
        var allowedSet = mapping?.Allowlist?
            .Select(a => (a.Kind, a.MemberName))
            .ToHashSet() ?? new HashSet<(string, string)>();
        var filteredMismatches = mismatches
            .Where(mm => !allowedSet.Contains((mm.Kind, mm.Name)))
            .ToList();

        int passMembers = chor.Members.Count - filteredMismatches.Count(mm =>
            mm.Kind == "missing-rust" || mm.Kind == "value-mismatch");
        if (passMembers < 0) passMembers = 0;
        int failMembers = filteredMismatches.Count;
        string status = filteredMismatches.Count == 0 ? "pass" : "fail";

        return new EnumParityRow(
            ChoriziteName: chor.EnumName,
            RustName: rustName,
            RustRelativePath: rustPath,
            Status: status,
            CheckedMembers: chor.Members.Count,
            PassMembers: passMembers,
            FailMembers: failMembers,
            Mismatches: filteredMismatches);
    }

    /// <summary>
    /// Discover Rust enum source files. We scan once per call but cache
    /// nothing across calls — the parity report is rare enough not to need
    /// memoization, and skipping the cache keeps the diagnostic
    /// deterministic across edits.
    /// </summary>
    private static (string RelPath, int LineNumber)? FindRustEnumByName(string rustRoot, string enumName) {
        if (!Directory.Exists(rustRoot)) return null;
        // Walk *.rs under rustRoot/. Skip target/, .git/.
        foreach (var file in EnumerateRustSourceFiles(rustRoot)) {
            int lineNo = 0;
            using var reader = new StreamReader(file);
            string? line;
            while ((line = reader.ReadLine()) != null) {
                lineNo++;
                // Match: `pub enum <name> {`, `pub enum <name> : T {`, or `pub enum <name>` (start of decl).
                // The Rust source usually has `pub enum Foo {` on a single line.
                if (line.TrimStart().StartsWith($"pub enum {enumName}", StringComparison.Ordinal)) {
                    // Ensure it's not a substring match (e.g. `pub enum FooBar` when querying `Foo`).
                    var trimmed = line.TrimStart();
                    var nameStart = "pub enum ".Length;
                    if (nameStart + enumName.Length <= trimmed.Length) {
                        var charAfter = nameStart + enumName.Length < trimmed.Length
                            ? trimmed[nameStart + enumName.Length]
                            : '\0';
                        if (charAfter == ' ' || charAfter == '{' || charAfter == '\t' || charAfter == '<' || charAfter == '\0') {
                            var relPath = Path.GetRelativePath(rustRoot, file).Replace(Path.DirectorySeparatorChar, '/');
                            return (relPath, lineNo);
                        }
                    }
                }
            }
        }
        return null;
    }

    private static IEnumerable<string> EnumerateRustSourceFiles(string rustRoot) {
        return Directory.EnumerateFiles(rustRoot, "*.rs", SearchOption.AllDirectories)
            .Where(p => !p.Contains($"{Path.DirectorySeparatorChar}target{Path.DirectorySeparatorChar}")
                     && !p.Contains($"{Path.DirectorySeparatorChar}.git{Path.DirectorySeparatorChar}"));
    }

    public sealed record RustEnumMember(string Name, long Value);

    /// <summary>
    /// Parse one Rust enum block, returning members + values. We scan from
    /// the <c>pub enum &lt;name&gt; …</c> line forward until matching the
    /// closing brace, accumulating <c>Variant = NN,</c> or <c>Variant,</c>
    /// entries.
    ///
    /// For variants without an explicit discriminant, we assume sequential
    /// integers starting at the previous discriminant + 1 (Rust language
    /// semantics for <c>#[repr(uN)]</c> enums). This matches the Chorizite
    /// <c>Enum.GetValues</c> behavior for default-int enums.
    ///
    /// Returns null if the enum block isn't found in the file (e.g. the
    /// manual mapping is stale).
    /// </summary>
    private static IReadOnlyList<RustEnumMember>? ParseRustEnumBlock(string filePath, string enumName) {
        var src = File.ReadAllText(filePath);
        // Locate `pub enum <name> {` (allowing a `: T` or generic clause between).
        var headerRe = new Regex($@"pub\s+enum\s+{Regex.Escape(enumName)}(?:\s*:\s*[A-Za-z0-9_]+)?\s*\{{",
            RegexOptions.Compiled);
        var headerMatch = headerRe.Match(src);
        if (!headerMatch.Success) return null;
        int openBrace = headerMatch.Index + headerMatch.Length - 1;
        // Walk forward, depth-counting on { } to find the matching close.
        int depth = 0;
        int closeBrace = -1;
        for (int i = openBrace; i < src.Length; i++) {
            char c = src[i];
            if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) { closeBrace = i; break; }
            }
        }
        if (closeBrace < 0) return null;
        var body = src.Substring(openBrace + 1, closeBrace - openBrace - 1);

        // Strip comments (//) and block comments (/* */) to keep the variant
        // scanner simple. The Rust enums of interest don't have nested
        // comments worth worrying about.
        body = Regex.Replace(body, @"/\*.*?\*/", "", RegexOptions.Singleline);
        body = Regex.Replace(body, @"//.*?(?=\n|$)", "");

        // Match variants: `Identifier` or `Identifier = NN` (NN may be 0xHEX,
        // 0bBIN, decimal, or even an arithmetic expression like `0xF7B0 + 1`).
        // We deliberately bail on arithmetic-expression discriminants for now
        // since none of the Chorizite-counterpart Rust enums use them.
        var memberRe = new Regex(
            @"^[ \t]*(?<name>[A-Z][A-Za-z0-9_]*)\s*(?:=\s*(?<val>(?:0x[0-9A-Fa-f_]+|0b[01_]+|-?[0-9_]+))\s*)?(?:,|$)",
            RegexOptions.Compiled | RegexOptions.Multiline);
        var members = new List<RustEnumMember>();
        long previous = -1;
        foreach (Match m in memberRe.Matches(body)) {
            var name = m.Groups["name"].Value;
            long value;
            if (m.Groups["val"].Success) {
                value = ParseRustDiscriminant(m.Groups["val"].Value);
            } else {
                value = previous + 1;
            }
            members.Add(new RustEnumMember(name, value));
            previous = value;
        }
        return members;
    }

    /// <summary>
    /// Parse a Rust integer literal (with optional 0x/0b prefix and _
    /// separators) to a long. Returns 0 for malformed input — we don't
    /// expect malformed input but a defensive fallback beats throwing on a
    /// parser hiccup mid-diagnostic.
    /// </summary>
    private static long ParseRustDiscriminant(string literal) {
        literal = literal.Replace("_", "");
        try {
            if (literal.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                return Convert.ToInt64(literal.Substring(2), 16);
            if (literal.StartsWith("0b", StringComparison.OrdinalIgnoreCase))
                return Convert.ToInt64(literal.Substring(2), 2);
            return long.Parse(literal, System.Globalization.CultureInfo.InvariantCulture);
        } catch {
            return 0;
        }
    }

    /// <summary>
    /// Default location of the holtburger Rust crates root. Walks up from
    /// AppContext.BaseDirectory looking for <c>external/holtburger/crates</c>.
    /// Falls back to a known path if the walk fails (commands check existence
    /// anyway).
    /// </summary>
    public static string DefaultHoltburgerCratesRoot {
        get {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null) {
                var candidate = Path.Combine(dir.FullName, "external", "holtburger", "crates");
                if (Directory.Exists(candidate)) return candidate;
                dir = dir.Parent;
            }
            return "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/crates";
        }
    }
}
