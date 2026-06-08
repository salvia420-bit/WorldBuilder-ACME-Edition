using System.Collections.Generic;
using System.IO;
using System.Linq;

using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Tests;

/// <summary>
/// Pins the contract for E1 (wave-2) PR3 — Option B (per-PLACEMENT biota override, SHARD DB):
/// biota stub + biota_properties_* emitters, the static 0x70000xxx guid threading/minting, the
/// SQL re-import round-trip, and the E6 offline validation gate + negative-PaletteTemplate
/// diagnostic. ALL tests are DB-free (golden / file-emit / mock).
///
/// Invariant families:
///   1. GOLDEN biota SQL matches ACE BiotaSQLWriter shape (id-keyed; palette adds `order`;
///      generator 3rd column is biota_Class_Id; stub default flags 4294967295). Idempotent DELETE.
///   2. Guid threading: PlacementOverride placements key on the placement guid; a missing guid is
///      MINTED in the landblock static range; an out-of-range guid is SKIPPED with a warning. Never
///      crossed with the world weenie tables.
///   3. Re-import: read the generated per-table SQL back into placements value-exact (round-trip).
///   4. E6 validation gate (offline, WeenieIndex): unknown wcid / generator target = ERROR (blocks);
///      subpalette-not-DID = ERROR; negative PaletteTemplate / ephemeral Home / bad flags = WARNING.
///   5. Apply path is real + DB-free-testable via the script-collection seam (no live DB needed).
/// </summary>
public class BiotaOverrideSqlTests {

    // ── Fixtures ─────────────────────────────────────────────────────────

    private static PlacementDye SampleDye() => new() {
        SubPaletteId = 0x04001234u, Offset = 8, Length = 16,
        PaletteTemplate = 23, Shade = 0.5f,
    };

    private static PlacementGenerator SampleGenerator() => new() {
        Probability = 1.0f, WeenieClassId = 7, Delay = 5.0f, InitCreate = 1, MaxCreate = 3,
        WhenCreate = 0x4u, WhereCreate = 0x01u, StackSize = null, PaletteTemplate = 12, Shade = 0.25f,
        ObjCellId = 0xAB12_0100u, OriginX = 1.5f, OriginY = 2.5f, OriginZ = 3.5f,
        AnglesW = 1f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0f,
    };

    private static Dictionary<PositionType, PlacementPosition> SamplePositions() => new() {
        [PositionType.Location] = new PlacementPosition {
            ObjCellId = 0xAB12_0001u, OriginX = 10f, OriginY = 20f, OriginZ = 30f,
            AnglesW = 1f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0f,
        },
    };

    private const uint Guid0 = 0x7AB12000u; // first static guid for landblock 0xAB12

    /// <summary>A WeenieIndex that resolves the given wcids to a real (non-Undef) WeenieType=1.</summary>
    private static WeenieIndex IndexFor(params int[] wcids) {
        var dict = new Dictionary<int, WeenieIndexEntry>();
        foreach (var w in wcids)
            dict[w] = new WeenieIndexEntry(
                Wcid: w, ClassName: $"wcid_{w}", WeenieType: 1, IsServerManaged: false, IsNpc: false,
                DisplayName: $"wcid {w}", Title: null, SetupDid: 0x02000001u, IconDid: null,
                PaletteBaseDid: null, CreatureType: null, Level: null, SourceMask: WeenieSource.AceDb);
        return new WeenieIndex(dict);
    }

    // The biota exporter resolves WeenieType from the index; all Option-B fixtures use these wcids.
    private static WeenieIndex BiotaIndex() => IndexFor(1234, 5678, 7);

    // ── 1. Golden biota SQL ──────────────────────────────────────────────

    [Fact]
    public void BiotaStubSql_Golden_IdKeyedNonDestructiveUpsert() {
        // PR3: non-destructive UPSERT (NOT DELETE FROM biota, which would cascade-wipe the object's
        // other persisted children). weenie_Type is the resolved real type (here 1), never Undef.
        const string expected =
            "INSERT INTO `biota` (`id`, `weenie_Class_Id`, `weenie_Type`, `populated_Collection_Flags`)\n" +
            "VALUES (2058428416, 1234, 1, 4294967295)\n" +
            "ON DUPLICATE KEY UPDATE `weenie_Class_Id` = 1234, `weenie_Type` = 1;\n";
        string sql = AceDbConnector.GenerateBiotaStubSql(Guid0, 1234, weenieType: 1);
        Assert.Equal(expected, sql);
        Assert.DoesNotContain("DELETE FROM `biota`", sql); // never cascade-wipe the parent
        Assert.Equal(2058428416u, Guid0); // 0x7AB12000
    }

    [Fact]
    public void BiotaPaletteSql_Golden_HasOrderColumn() {
        // ACE biota_properties_palette adds the `order` column the weenie table lacks (BiotaSQLWriter.cs:655).
        const string expected =
            "DELETE FROM `biota_properties_palette` WHERE `object_Id` = 2058428416;\n" +
            "INSERT INTO `biota_properties_palette` (`object_Id`, `sub_Palette_Id`, `offset`, `length`, `order`)\n" +
            "VALUES (2058428416, 67113524, 8, 16, 0) /* sub_Palette_Id 0x04001234 */;\n";
        string sql = AceDbConnector.GenerateBiotaPaletteSql(Guid0, SampleDye())!;
        Assert.Equal(expected, sql);
        Assert.Contains("`order`", sql);
    }

    [Fact]
    public void BiotaGeneratorSql_Golden_ThirdColumnIsBiotaClassId() {
        // Identical to the weenie generator EXCEPT column 3 name is biota_Class_Id (BiotaSQLWriter.cs:611).
        const string expected =
            "DELETE FROM `biota_properties_generator` WHERE `object_Id` = 2058428416;\n" +
            "INSERT INTO `biota_properties_generator` (`object_Id`, `probability`, `biota_Class_Id`, " +
            "`delay`, `init_Create`, `max_Create`, `when_Create`, `where_Create`, `stack_Size`, `palette_Id`, `shade`, " +
            "`obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z`)\n" +
            "VALUES (2058428416, 1, 7, 5, 1, 3, 4, 1, NULL, 12, 0.25, 0xAB120100, 1.5, 2.5, 3.5, 1, 0, 0, 0);\n";
        string sql = AceDbConnector.GenerateBiotaGeneratorSql(Guid0, new List<PlacementGenerator> { SampleGenerator() })!;
        Assert.Equal(expected, sql);
        Assert.Contains("`biota_Class_Id`", sql);
        Assert.DoesNotContain("`weenie_Class_Id`", sql); // never the world column name
    }

    [Fact]
    public void BiotaPositionSql_Golden_NumericPositionType() {
        const string expected =
            "DELETE FROM `biota_properties_position` WHERE `object_Id` = 2058428416;\n" +
            "INSERT INTO `biota_properties_position` (`object_Id`, `position_Type`, `obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z`)\n" +
            "VALUES (2058428416, 1, 0xAB120001, 10, 20, 30, 1, 0, 0, 0);\n";
        string sql = AceDbConnector.GenerateBiotaPositionSql(Guid0, SamplePositions())!;
        Assert.Equal(expected, sql);
    }

    [Fact]
    public void BiotaIntFloatSql_Golden_Type3And12() {
        Assert.Equal(
            "DELETE FROM `biota_properties_int` WHERE `object_Id` = 2058428416 AND `type` = 3;\n" +
            "INSERT INTO `biota_properties_int` (`object_Id`, `type`, `value`)\n" +
            "VALUES (2058428416, 3, 23) /* PaletteTemplate */;\n",
            AceDbConnector.GenerateBiotaPaletteTemplateIntSql(Guid0, SampleDye())!);
        Assert.Equal(
            "DELETE FROM `biota_properties_float` WHERE `object_Id` = 2058428416 AND `type` = 12;\n" +
            "INSERT INTO `biota_properties_float` (`object_Id`, `type`, `value`)\n" +
            "VALUES (2058428416, 12, 0.5) /* Shade */;\n",
            AceDbConnector.GenerateBiotaShadeFloatSql(Guid0, SampleDye())!);
    }

    // ── 2. Guid threading / static range ─────────────────────────────────

    [Fact]
    public void StaticGuidAllocator_MatchesAcePolicy() {
        // 0x70000000 | (landblock << 12) | seq; window is 4096 wide.
        Assert.Equal(0x7AB12000u, StaticGuidAllocator.FirstStaticGuid(0xAB12));
        Assert.Equal(0x7AB12FFFu, StaticGuidAllocator.MaxStaticGuid(0xAB12));
        Assert.True(StaticGuidAllocator.IsStatic(0x70000000u));
        Assert.True(StaticGuidAllocator.IsStatic(0x7FFFFFFFu));
        Assert.False(StaticGuidAllocator.IsStatic(0x6FFFFFFFu));
        Assert.False(StaticGuidAllocator.IsStatic(0x80000000u)); // dynamic
        Assert.True(StaticGuidAllocator.IsInLandblockStaticRange(0xAB12, 0x7AB12005u));
        Assert.False(StaticGuidAllocator.IsInLandblockStaticRange(0xAB12, 0x7AB13000u));
    }

    [Fact]
    public void StaticGuidAllocator_FillsGapsAroundExplicitGuids() {
        var used = new HashSet<uint> { 0x7AB12000u };
        Assert.Equal(0x7AB12001u, StaticGuidAllocator.Allocate(0xAB12, used));
        Assert.Equal(0x7AB12002u, StaticGuidAllocator.Allocate(0xAB12, used));
    }

    [Fact]
    public void BiotaExporter_MintsGuidInStaticRange_WhenAbsent() {
        var over = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Scope = EnrichmentScope.PlacementOverride, Dye = SampleDye(),
        };
        var bundle = BiotaEnrichmentSqlExporter.Build(new[] { over }, BiotaIndex());
        Assert.Single(bundle.Assignments);
        var a = bundle.Assignments[0];
        Assert.True(a.Minted);
        Assert.Equal(0x7AB12000u, a.Guid);
        Assert.True(StaticGuidAllocator.IsInLandblockStaticRange(0xAB12, a.Guid));
        // The biota stub + palette SQL are keyed by the minted guid.
        Assert.Contains("VALUES (2058428416,", bundle.Biota!.Sql);
        Assert.Contains("object_Id` = 2058428416", bundle.Palette!.Sql);
        // The minted guid is written back onto the source placement (stable addressable key).
        Assert.Equal(0x7AB12000u, over.Guid);
    }

    [Fact]
    public void BiotaExporter_HonorsExplicitInRangeGuid() {
        var over = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Guid = 0x7AB12009u, Scope = EnrichmentScope.PlacementOverride, Dye = SampleDye(),
        };
        var bundle = BiotaEnrichmentSqlExporter.Build(new[] { over }, BiotaIndex());
        Assert.False(bundle.Assignments[0].Minted);
        Assert.Equal(0x7AB12009u, bundle.Assignments[0].Guid);
    }

    [Fact]
    public void BiotaExporter_SkipsOutOfStaticRangeGuid_WithWarning() {
        var over = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Guid = 0x80000001u, // dynamic range — server would never read this biota
            Scope = EnrichmentScope.PlacementOverride, Dye = SampleDye(),
        };
        var bundle = BiotaEnrichmentSqlExporter.Build(new[] { over }, BiotaIndex());
        Assert.Equal(1, bundle.Skipped);
        Assert.Empty(bundle.Assignments);
        Assert.False(bundle.HasAny);
        Assert.Contains(bundle.Warnings, w => w.Kind == "guid_out_of_static_range");
    }

    [Fact]
    public void BiotaExporter_ClassDefaultScope_NotEmitted_NeverCrossed() {
        // A ClassDefault placement must NOT produce any biota row (that is the world weenie path).
        var classDefault = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Scope = EnrichmentScope.ClassDefault, Dye = SampleDye(),
        };
        var bundle = BiotaEnrichmentSqlExporter.Build(new[] { classDefault }, BiotaIndex());
        Assert.False(bundle.HasAny);
        Assert.Empty(bundle.Assignments);
    }

    [Fact]
    public void MixedScope_RoutesEachToCorrectExporter_WorldVsShardNeverCrossed() {
        // One set with BOTH an Option A (ClassDefault → world weenie_properties_*) and an Option B
        // (PlacementOverride → shard biota_properties_*) placement. Each exporter emits ONLY its own
        // scope's rows; the world SQL never contains a biota table and vice-versa (HARD CONSTRAINT 3).
        var classDefault = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Scope = EnrichmentScope.ClassDefault, Dye = SampleDye(),
        };
        var over = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 2, WeenieClassId = 5678,
            Guid = 0x7AB12010u, Scope = EnrichmentScope.PlacementOverride, Dye = SampleDye(),
        };

        var world = EnrichmentSqlExporter.Build(new[] { classDefault, over });
        var shard = BiotaEnrichmentSqlExporter.Build(new[] { classDefault, over }, BiotaIndex());

        // World bundle: only the ClassDefault wcid 1234; the PlacementOverride is counted-and-skipped.
        Assert.NotNull(world.Palette);
        Assert.Equal(1, world.Palette!.WeenieCount);
        Assert.Contains("object_Id` = 1234", world.Palette.Sql);
        Assert.DoesNotContain("biota", world.Palette.Sql);
        Assert.Equal(1, world.PlacementOverrideSkipped);

        // Shard bundle: only the PlacementOverride guid; never the world weenie tables.
        Assert.NotNull(shard.Palette);
        Assert.Single(shard.Assignments);
        Assert.Equal(0x7AB12010u, shard.Assignments[0].Guid);
        Assert.DoesNotContain("weenie_properties", shard.Palette!.Sql);
        Assert.DoesNotContain("1234", shard.Biota!.Sql.Split('\n').FirstOrDefault(l => l.Contains("weenie_Class_Id")) ?? "");
    }

    [Fact]
    public void BiotaExporter_DeterministicOrdering_AscendingGuid() {
        EnrichedPlacement Over(ushort lb, uint? guid) => new() {
            Kind = "outdoor", Landblock = lb, CellNumber = 1, WeenieClassId = 1234,
            Guid = guid, Scope = EnrichmentScope.PlacementOverride, Dye = SampleDye(),
        };
        var p1 = Over(0xAB12, 0x7AB12005u);
        var p2 = Over(0xAB12, 0x7AB12001u);
        var a = BiotaEnrichmentSqlExporter.Build(new[] { p1, p2 }, BiotaIndex());
        var b = BiotaEnrichmentSqlExporter.Build(new[] { p2, p1 }, BiotaIndex());
        Assert.Equal(a.Biota!.Sql, b.Biota!.Sql);
        Assert.True(a.Biota!.Sql.IndexOf("VALUES (2058428417,") < a.Biota!.Sql.IndexOf("VALUES (2058428421,"));
    }

    // ── 3. Negative-PaletteTemplate diagnostic ───────────────────────────

    [Fact]
    public void BiotaExporter_NegativePaletteTemplate_SurfacedAsWarning_AndClampedInSql() {
        var over = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Scope = EnrichmentScope.PlacementOverride,
            Generators = new List<PlacementGenerator> {
                new PlacementGenerator { Probability = 1f, WeenieClassId = 7, InitCreate = 1, MaxCreate = 1,
                    WhenCreate = 0, WhereCreate = 0, PaletteTemplate = -5 },
            },
        };
        var bundle = BiotaEnrichmentSqlExporter.Build(new[] { over }, BiotaIndex());
        Assert.Contains(bundle.Warnings, w => w.Kind == "negative_palette_template_clamped");
        // The emitted SQL clamps -5 → 0 (never the bare -5).
        Assert.DoesNotContain("-5", bundle.Generator!.Sql);
    }

    // ── 4. File emit (no DB) ─────────────────────────────────────────────

    [Fact]
    public void BiotaWriteFiles_EmitsPerTableSqlPlusManifest_NoDb() {
        var placements = new List<EnrichedPlacement> {
            new EnrichedPlacement {
                Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
                Scope = EnrichmentScope.PlacementOverride,
                Dye = SampleDye(),
                Generators = new List<PlacementGenerator> { SampleGenerator() },
                Positions = SamplePositions(),
            },
        };
        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr3_{System.Guid.NewGuid():N}");
        try {
            var (bundle, written, manifestPath) = BiotaEnrichmentSqlExporter.WriteFiles(dir, placements, BiotaIndex());
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.BiotaSqlFileName)));
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.BiotaPaletteSqlFileName)));
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.BiotaGeneratorSqlFileName)));
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.BiotaPositionSqlFileName)));
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.BiotaIntSqlFileName)));
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.BiotaFloatSqlFileName)));
            Assert.True(File.Exists(manifestPath));
            Assert.Equal(6, written.Count); // biota + 5 property tables

            string manifest = File.ReadAllText(manifestPath);
            Assert.Contains("\"scope\":\"PlacementOverride\"", manifest);
            Assert.Contains("\"db\":\"shard\"", manifest);
            Assert.Contains("\"minted\":true", manifest);
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    // ── 5. SQL re-import round-trip ──────────────────────────────────────

    [Fact]
    public void Reimport_OptionA_RoundTripsValueExact() {
        // Emit the world per-class SQL, then read it back. The recovered placement must carry the
        // SAME dye / generators / positions (value-exact).
        var src = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Scope = EnrichmentScope.ClassDefault,
            Dye = SampleDye(),
            Generators = new List<PlacementGenerator> { SampleGenerator() },
            Positions = SamplePositions(),
        };
        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr3_reimpA_{System.Guid.NewGuid():N}");
        try {
            EnrichmentSqlExporter.WriteFiles(dir, new[] { src });
            var back = EnrichmentSqlImporter.ReadDir(dir);
            var p = Assert.Single(back);
            Assert.Equal(EnrichmentScope.ClassDefault, p.Scope);
            Assert.Equal(1234u, p.WeenieClassId);
            AssertDyeEqual(src.Dye!, p.Dye!);
            AssertGeneratorEqual(src.Generators![0], p.Generators![0]);
            Assert.True(p.Positions!.ContainsKey(PositionType.Location));
            AssertPositionEqual(src.Positions![PositionType.Location], p.Positions[PositionType.Location]);
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Reimport_OptionB_RoundTripsValueExact_WithGuid() {
        var src = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Guid = 0x7AB12000u, Scope = EnrichmentScope.PlacementOverride,
            Dye = SampleDye(),
            Generators = new List<PlacementGenerator> { SampleGenerator() },
            Positions = SamplePositions(),
        };
        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr3_reimpB_{System.Guid.NewGuid():N}");
        try {
            BiotaEnrichmentSqlExporter.WriteFiles(dir, new[] { src }, BiotaIndex());
            var back = EnrichmentSqlImporter.ReadDir(dir);
            var p = Assert.Single(back);
            Assert.Equal(EnrichmentScope.PlacementOverride, p.Scope);
            Assert.Equal(0x7AB12000u, p.Guid);
            // PR3: the wcid is recovered from the parsed biota STUB (the only Option B SQL artifact
            // that carries it) — value-exact, not reset to 0.
            Assert.Equal(1234u, p.WeenieClassId);
            // And the landblock is derivable from the static guid (0x70000000 | lb<<12 | seq).
            Assert.Equal((ushort)0xAB12, p.Landblock);
            AssertDyeEqual(src.Dye!, p.Dye!);
            AssertGeneratorEqual(src.Generators![0], p.Generators![0]);
            AssertPositionEqual(src.Positions![PositionType.Location], p.Positions![PositionType.Location]);
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    // ── 6. E6 validation gate (offline, WeenieIndex) ─────────────────────

    private static WeenieIndex IndexWith(params int[] wcids) {
        var dict = new Dictionary<int, WeenieIndexEntry>();
        foreach (var w in wcids)
            dict[w] = new WeenieIndexEntry(
                Wcid: w, ClassName: $"wcid_{w}", WeenieType: 1, IsServerManaged: false, IsNpc: false,
                DisplayName: $"wcid {w}", Title: null, SetupDid: 0x02000001u, IconDid: null,
                PaletteBaseDid: null, CreatureType: null, Level: null, SourceMask: WeenieSource.AceDb);
        return new WeenieIndex(dict);
    }

    [Fact]
    public void Validate_UnknownWcid_IsError() {
        var p = new EnrichedPlacement { Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 9999 };
        var report = EnrichedPlacementValidator.Validate(new[] { p }, IndexWith(1234));
        Assert.False(report.Ok);
        Assert.Contains(report.Findings, f => f.Code == "wcid_unresolved" && f.Severity == EnrichedPlacementValidator.Severity.Error);
    }

    [Fact]
    public void Validate_GeneratorTargetUnresolved_IsError() {
        var p = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
            Generators = new List<PlacementGenerator> {
                new PlacementGenerator { Probability = 1f, WeenieClassId = 5555, InitCreate = 1, MaxCreate = 1 },
            },
        };
        var report = EnrichedPlacementValidator.Validate(new[] { p }, IndexWith(1234));
        Assert.False(report.Ok);
        Assert.Contains(report.Findings, f => f.Code == "generator_target_unresolved");
    }

    [Fact]
    public void Validate_SubPaletteNotDid_IsError() {
        var p = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
            Dye = new PlacementDye { SubPaletteId = 0x12345u }, // not a 0x04 DID
        };
        var report = EnrichedPlacementValidator.Validate(new[] { p }, IndexWith(1234));
        Assert.False(report.Ok);
        Assert.Contains(report.Findings, f => f.Code == "dye_subpalette_not_did");
    }

    [Fact]
    public void Validate_NegativePaletteTemplate_IsWarning_NotError() {
        var p = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
            Dye = new PlacementDye { PaletteTemplate = -7 },
        };
        var report = EnrichedPlacementValidator.Validate(new[] { p }, IndexWith(1234));
        Assert.True(report.Ok); // warnings don't block
        Assert.Contains(report.Findings, f => f.Code == "dye_palette_template_negative" && f.Severity == EnrichedPlacementValidator.Severity.Warning);
    }

    [Fact]
    public void Validate_EphemeralHomePosition_IsWarning() {
        var p = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
            Positions = new Dictionary<PositionType, PlacementPosition> {
                [PositionType.Home] = new PlacementPosition { ObjCellId = 1, AnglesW = 1f },
            },
        };
        var report = EnrichedPlacementValidator.Validate(new[] { p }, IndexWith(1234));
        Assert.True(report.Ok);
        Assert.Contains(report.Findings, f => f.Code == "position_key_ephemeral");
    }

    [Fact]
    public void Validate_AllResolved_Ok() {
        var p = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
            Dye = new PlacementDye { SubPaletteId = 0x04001234u, PaletteTemplate = 5, Shade = 0.5f },
            Generators = new List<PlacementGenerator> {
                new PlacementGenerator { Probability = 1f, WeenieClassId = 7, InitCreate = 1, MaxCreate = 3,
                    WhenCreate = 0x4u, WhereCreate = 0x01u },
            },
            Positions = new Dictionary<PositionType, PlacementPosition> {
                [PositionType.Location] = new PlacementPosition { ObjCellId = 1, AnglesW = 1f },
            },
        };
        var report = EnrichedPlacementValidator.Validate(new[] { p }, IndexWith(1234, 7));
        Assert.True(report.Ok);
        Assert.Equal(0, report.ErrorCount);
    }

    [Fact]
    public void Validate_EmptyIndex_SkipsWcidChecks_Warns_DoesNotBlock() {
        var p = new EnrichedPlacement { Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 9999 };
        var report = EnrichedPlacementValidator.Validate(new[] { p }, WeenieIndex.Empty);
        Assert.True(report.Ok); // no hard fail when the index was never ingested
        Assert.Contains(report.Findings, f => f.Code == "index_empty");
        Assert.DoesNotContain(report.Findings, f => f.Code == "wcid_unresolved");
    }

    [Fact]
    public void Validate_ReportSerialize_IsDeterministicAndWritable() {
        var p1 = new EnrichedPlacement { Kind = "outdoor", Landblock = 2, CellNumber = 1, WeenieClassId = 9999 };
        var p2 = new EnrichedPlacement { Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 8888 };
        var fwd = EnrichedPlacementValidator.Validate(new[] { p1, p2 }, IndexWith(1234));
        var rev = EnrichedPlacementValidator.Validate(new[] { p2, p1 }, IndexWith(1234));
        Assert.Equal(EnrichedPlacementValidator.SerializeReport(fwd), EnrichedPlacementValidator.SerializeReport(rev));

        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr3_valrep_{System.Guid.NewGuid():N}");
        try {
            var path = EnrichedPlacementValidator.WriteReport(dir, fwd);
            Assert.True(File.Exists(path));
            Assert.EndsWith("validation_report.jsonl", path);
            string text = File.ReadAllText(path);
            Assert.Contains("\"summary\":true", text);
            Assert.Contains("\"ok\":false", text);
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    // ── 7. Apply-path routing (DB-free) ──────────────────────────────────

    [Fact]
    public void ApplyPlan_RoutesWorldAndShardSeparately_NeverCrossed_NoDb() {
        // The live --apply path's ROUTING is a pure function (EnrichmentApplyPlan.Build) — provable
        // without any DB. World gets placements + per-class weenie SQL; shard gets biota SQL; the two
        // lists are disjoint by table family (HARD CONSTRAINT 3). The actual DB write is a separate,
        // human-verified integration step (ExecuteScriptsTransactionalAsync), never hit here.
        var classDefault = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Scope = EnrichmentScope.ClassDefault, Dye = SampleDye(),
        };
        var over = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 2, WeenieClassId = 5678,
            Guid = 0x7AB12010u, Scope = EnrichmentScope.PlacementOverride, Dye = SampleDye(),
        };
        var world = EnrichmentSqlExporter.Build(new[] { classDefault, over });
        var shard = BiotaEnrichmentSqlExporter.Build(new[] { classDefault, over }, BiotaIndex());

        var plan = EnrichmentApplyPlan.Build(
            outdoorSql: "INSERT INTO `ace_world`.`landblock_instance` ...;", outdoorCount: 2,
            dungeonSql: null, dungeonCount: 0,
            world, shard);

        Assert.NotEmpty(plan.WorldScripts);
        Assert.True(plan.RequiresShard);

        // Every world script targets a world table family; none touches a biota table.
        foreach (var s in plan.WorldScripts) {
            Assert.NotNull(s);
            Assert.DoesNotContain("`biota", s!);
        }
        // Every shard script targets a biota table; none touches a weenie_properties table.
        foreach (var s in plan.ShardScripts) {
            Assert.NotNull(s);
            Assert.Contains("biota", s!);
            Assert.DoesNotContain("weenie_properties", s!);
        }
    }

    [Fact]
    public void ApplyPlan_NoOverrides_DoesNotRequireShard() {
        var classDefault = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
            Scope = EnrichmentScope.ClassDefault, Dye = SampleDye(),
        };
        var world = EnrichmentSqlExporter.Build(new[] { classDefault });
        var shard = BiotaEnrichmentSqlExporter.Build(new[] { classDefault }, BiotaIndex());
        var plan = EnrichmentApplyPlan.Build("x;", 1, null, 0, world, shard);
        Assert.False(plan.RequiresShard);
        Assert.Empty(plan.ShardScripts);
    }

    // ── 8. Guid threading through placement models + JSONL + MemoryPack ───

    [Fact]
    public void Guid_ThreadsThroughOutdoorModel_AndJsonl() {
        var outdoor = new OutdoorInstancePlacement {
            LandblockId = 0xAB12, WeenieClassId = 1234, CellNumber = 1,
            OriginX = 1, OriginY = 2, OriginZ = 3, Guid = 0x7AB12000u,
        };
        var e = EnrichedPlacementStore.FromOutdoor(outdoor, EnrichmentScope.PlacementOverride);
        Assert.Equal(0x7AB12000u, e.Guid);
        // JSONL round-trip preserves the guid…
        var back = EnrichedPlacementStore.DeserializeLine(EnrichedPlacementStore.SerializeLine(e))!;
        Assert.Equal(0x7AB12000u, back.Guid);
        // …and rebuilding the model recovers it.
        var rebuilt = EnrichedPlacementStore.ToOutdoor(back);
        Assert.Equal(0x7AB12000u, rebuilt.Guid);
    }

    [Fact]
    public void Guid_ThreadsThroughDungeonModel_MemoryPackAppendOnly() {
        var p = new WorldBuilder.Shared.Documents.DungeonInstancePlacement {
            WeenieClassId = 1234, CellNumber = 0x0100,
            Origin = new System.Numerics.Vector3(1, 2, 3),
            Orientation = System.Numerics.Quaternion.Identity,
            Guid = 0x7AB12001u,
        };
        var bytes = MemoryPack.MemoryPackSerializer.Serialize(p);
        var back = MemoryPack.MemoryPackSerializer.Deserialize<WorldBuilder.Shared.Documents.DungeonInstancePlacement>(bytes)!;
        Assert.Equal(0x7AB12001u, back.Guid);

        // Append-only: an OLD blob (no Guid slot) still deserializes with Guid null.
        var noGuid = new WorldBuilder.Shared.Documents.DungeonInstancePlacement {
            WeenieClassId = 5, CellNumber = 0x0100,
            Origin = new System.Numerics.Vector3(1, 2, 3), Orientation = System.Numerics.Quaternion.Identity,
        };
        var nb = MemoryPack.MemoryPackSerializer.Deserialize<WorldBuilder.Shared.Documents.DungeonInstancePlacement>(
            MemoryPack.MemoryPackSerializer.Serialize(noGuid))!;
        Assert.Null(nb.Guid);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static void AssertDyeEqual(PlacementDye a, PlacementDye b) {
        Assert.Equal(a.SubPaletteId, b.SubPaletteId);
        Assert.Equal(a.Offset, b.Offset);
        Assert.Equal(a.Length, b.Length);
        Assert.Equal(a.PaletteTemplate, b.PaletteTemplate);
        Assert.Equal(a.Shade, b.Shade);
    }

    private static void AssertGeneratorEqual(PlacementGenerator a, PlacementGenerator b) {
        Assert.Equal(a.Probability, b.Probability);
        Assert.Equal(a.WeenieClassId, b.WeenieClassId);
        Assert.Equal(a.Delay, b.Delay);
        Assert.Equal(a.InitCreate, b.InitCreate);
        Assert.Equal(a.MaxCreate, b.MaxCreate);
        Assert.Equal(a.WhenCreate, b.WhenCreate);
        Assert.Equal(a.WhereCreate, b.WhereCreate);
        Assert.Equal(a.StackSize, b.StackSize);
        Assert.Equal(a.PaletteTemplate, b.PaletteTemplate);
        Assert.Equal(a.Shade, b.Shade);
        Assert.Equal(a.ObjCellId, b.ObjCellId);
        Assert.Equal(a.OriginX, b.OriginX);
        Assert.Equal(a.OriginY, b.OriginY);
        Assert.Equal(a.OriginZ, b.OriginZ);
        Assert.Equal(a.AnglesW, b.AnglesW);
        Assert.Equal(a.AnglesX, b.AnglesX);
        Assert.Equal(a.AnglesY, b.AnglesY);
        Assert.Equal(a.AnglesZ, b.AnglesZ);
    }

    private static void AssertPositionEqual(PlacementPosition a, PlacementPosition b) {
        Assert.Equal(a.ObjCellId, b.ObjCellId);
        Assert.Equal(a.OriginX, b.OriginX);
        Assert.Equal(a.OriginY, b.OriginY);
        Assert.Equal(a.OriginZ, b.OriginZ);
        Assert.Equal(a.AnglesW, b.AnglesW);
        Assert.Equal(a.AnglesX, b.AnglesX);
        Assert.Equal(a.AnglesY, b.AnglesY);
        Assert.Equal(a.AnglesZ, b.AnglesZ);
    }
}
