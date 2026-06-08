using System.Collections.Generic;
using System.IO;
using System.Linq;

using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Tests;

/// <summary>
/// Pins the contract for E1 (wave-2) PR2 — the per-CLASS (Option A) SQL emitters that GENERATE
/// ACE world-DB enrichment SQL from the enriched-placement data, plus the file-emit / dry-run
/// path and the PaletteTemplate clamp.
///
/// Invariant families:
///   1. GOLDEN per-table SQL is byte-pinned and matches ACE's WeenieSQLWriter format (table/column
///      names + order, VALUES formatting, NULL handling, hex/decimal rules, idempotent DELETE).
///   2. Addressability: sub_Palette_Id is the 0x04 DID; position_Type is the numeric enum (Home=5);
///      generator named columns map 1:1.
///   3. PaletteTemplate clamp to ACE's uint? domain (negative → 0) on the generator palette_Id.
///   4. Conflict handling (HARD CONSTRAINT 4): same wcid with DIFFERING enrichment is flagged and
///      skipped for that table, never silently picked.
///   5. The file-emit / dry-run path writes per-table .sql + a manifest and never touches a DB.
/// </summary>
public class EnrichmentSqlEmitterTests {

    // ── Fixtures (match the PR1 sample shapes for cross-test consistency) ──

    private static PlacementDye SampleDye() => new() {
        SubPaletteId = 0x04001234u,  // a real 0x04 Palette DID, NOT a list-local index
        Offset = 8,
        Length = 16,
        PaletteTemplate = 23,        // template tint (small enum index), secondary
        Shade = 0.5f,
    };

    private static PlacementGenerator SampleGenerator() => new() {
        Probability = 1.0f,
        WeenieClassId = 7,
        Delay = 5.0f,
        InitCreate = 1,
        MaxCreate = 3,
        WhenCreate = 0x4u,   // RegenerationType.Death
        WhereCreate = 0x01u, // RegenLocationType.OnTop
        StackSize = null,
        PaletteTemplate = 12,
        Shade = 0.25f,
        ObjCellId = 0xAB12_0100u,
        OriginX = 1.5f, OriginY = 2.5f, OriginZ = 3.5f,
        AnglesW = 1f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0f,
    };

    private static Dictionary<PositionType, PlacementPosition> SamplePositions() => new() {
        [PositionType.Home] = new PlacementPosition {
            ObjCellId = 0xAB12_0001u,
            OriginX = 10f, OriginY = 20f, OriginZ = 30f,
            AnglesW = 1f, AnglesX = 0f, AnglesY = 0f, AnglesZ = 0f,
        },
    };

    // ── 1. GOLDEN per-table SQL ──────────────────────────────────────────

    [Fact]
    public void PaletteSql_Golden_DecimalDidMatchesAceAndIdempotentDelete() {
        // ACE's WeenieSQLWriter.cs:797 emits sub_Palette_Id as PLAIN DECIMAL ({input[i].SubPaletteId})
        // — it never hex-formats this column (contrast obj_Cell_Id). 0x04001234 == 67113524.
        // The 0x04 DID addressability is carried by the VALUE; the hex is appended as an
        // ACE-style /* … */ crib comment (MySQL-insignificant) for human readers only.
        const string expected =
            "DELETE FROM `weenie_properties_palette` WHERE `object_Id` = 1234;\n" +
            "INSERT INTO `weenie_properties_palette` (`object_Id`, `sub_Palette_Id`, `offset`, `length`)\n" +
            "VALUES (1234, 67113524, 8, 16) /* sub_Palette_Id 0x04001234 */;\n";

        string sql = AceDbConnector.GeneratePaletteSql(1234, SampleDye())!;
        Assert.Equal(expected, sql);

        // Addressability: the emitted decimal IS the 0x04 DID (67113524 == 0x04001234), and the
        // hex crib documents it; neither is a list-local index.
        Assert.Contains("67113524", sql);
        Assert.Contains("0x04001234", sql);
    }

    [Fact]
    public void GeneratorSql_Golden_MatchesAceColumnListAndFormatting() {
        const string expected =
            "DELETE FROM `weenie_properties_generator` WHERE `object_Id` = 1234;\n" +
            "INSERT INTO `weenie_properties_generator` (`object_Id`, `probability`, `weenie_Class_Id`, " +
            "`delay`, `init_Create`, `max_Create`, `when_Create`, `where_Create`, `stack_Size`, `palette_Id`, `shade`, " +
            "`obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z`)\n" +
            "VALUES (1234, 1, 7, 5, 1, 3, 4, 1, NULL, 12, 0.25, 0xAB120100, 1.5, 2.5, 3.5, 1, 0, 0, 0);\n";

        string sql = AceDbConnector.GenerateGeneratorSql(1234, new List<PlacementGenerator> { SampleGenerator() })!;
        Assert.Equal(expected, sql);

        // when_Create / where_Create are decimal; palette_Id decimal; obj_Cell_Id hex; null StackSize → NULL.
        Assert.Contains(", 4, 1, NULL, 12, ", sql);
        Assert.Contains("0xAB120100", sql);
    }

    [Fact]
    public void PositionSql_Golden_PositionTypeIsNumericEnum() {
        const string expected =
            "DELETE FROM `weenie_properties_position` WHERE `object_Id` = 1234;\n" +
            "INSERT INTO `weenie_properties_position` (`object_Id`, `position_Type`, `obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z`)\n" +
            "VALUES (1234, 5, 0xAB120001, 10, 20, 30, 1, 0, 0, 0);\n";

        string sql = AceDbConnector.GeneratePositionSql(1234, SamplePositions())!;
        Assert.Equal(expected, sql);

        // Home → numeric 5, not a name or array offset.
        Assert.Contains("1234, 5, ", sql);
    }

    [Fact]
    public void IntSql_Golden_PaletteTemplateType3() {
        const string expected =
            "DELETE FROM `weenie_properties_int` WHERE `object_Id` = 1234 AND `type` = 3;\n" +
            "INSERT INTO `weenie_properties_int` (`object_Id`, `type`, `value`)\n" +
            "VALUES (1234, 3, 23) /* PaletteTemplate */;\n";

        string sql = AceDbConnector.GeneratePaletteTemplateIntSql(1234, SampleDye())!;
        Assert.Equal(expected, sql);
    }

    [Fact]
    public void FloatSql_Golden_ShadeType12() {
        const string expected =
            "DELETE FROM `weenie_properties_float` WHERE `object_Id` = 1234 AND `type` = 12;\n" +
            "INSERT INTO `weenie_properties_float` (`object_Id`, `type`, `value`)\n" +
            "VALUES (1234, 12, 0.5) /* Shade */;\n";

        string sql = AceDbConnector.GenerateShadeFloatSql(1234, SampleDye())!;
        Assert.Equal(expected, sql);
    }

    // ── 2. Null / absent-facet behavior ──────────────────────────────────

    [Fact]
    public void PaletteSql_TemplateOnlyDye_ReturnsNull() {
        // A dye with only PaletteTemplate/Shade (no SubPaletteId) emits NO palette row.
        var dye = new PlacementDye { PaletteTemplate = 5, Shade = 0.2f };
        Assert.Null(AceDbConnector.GeneratePaletteSql(7, dye));
        Assert.NotNull(AceDbConnector.GeneratePaletteTemplateIntSql(7, dye));
        Assert.NotNull(AceDbConnector.GenerateShadeFloatSql(7, dye));
    }

    [Fact]
    public void Emitters_EmptyOrNullInputs_ReturnNull() {
        Assert.Null(AceDbConnector.GenerateGeneratorSql(7, null));
        Assert.Null(AceDbConnector.GenerateGeneratorSql(7, new List<PlacementGenerator>()));
        Assert.Null(AceDbConnector.GeneratePositionSql(7, null));
        Assert.Null(AceDbConnector.GeneratePositionSql(7, new Dictionary<PositionType, PlacementPosition>()));
    }

    [Fact]
    public void GeneratorSql_MultipleProfiles_OneValuesRowEach_OrderPreserved() {
        var g1 = SampleGenerator();
        var g2 = SampleGenerator();
        g2.WeenieClassId = 99;
        string sql = AceDbConnector.GenerateGeneratorSql(1234, new List<PlacementGenerator> { g1, g2 })!;

        // ACE ValuesWriter shape: first "VALUES (", subsequent "     , (".
        Assert.Contains("VALUES (1234, 1, 7, ", sql);
        Assert.Contains("     , (1234, 1, 99, ", sql);
        // Exactly two ';' — one on the DELETE line, one terminating the last VALUES row.
        Assert.Equal(2, sql.Count(c => c == ';'));
        // The semicolon falls on the LAST profile row (g2 / wcid 99), not the first.
        Assert.EndsWith("99, 5, 1, 3, 4, 1, NULL, 12, 0.25, 0xAB120100, 1.5, 2.5, 3.5, 1, 0, 0, 0);\n", sql);
    }

    // ── 3. PaletteTemplate clamp (Finding 9) ─────────────────────────────

    [Fact]
    public void GeneratorSql_NegativePaletteTemplate_ClampedToZero() {
        var g = new PlacementGenerator {
            Probability = 1f, WeenieClassId = 7, InitCreate = 1, MaxCreate = 1,
            WhenCreate = 0, WhereCreate = 0, PaletteTemplate = -5,
        };
        string sql = AceDbConnector.GenerateGeneratorSql(99, new List<PlacementGenerator> { g })!;

        // palette_Id position (10th value) must be 0, not -5 — ACE's column is uint?. With no
        // spawn-loc override, obj_Cell_Id is a null uint? → NULL (ACE WeenieSQLWriter.cs:780, not 0).
        Assert.Contains("VALUES (99, 1, 7, NULL, 1, 1, 0, 0, NULL, 0, NULL, NULL, ", sql);
        Assert.DoesNotContain("-5", sql);
    }

    [Fact]
    public void GeneratorSql_NullPaletteTemplate_EmitsNull() {
        var g = new PlacementGenerator {
            Probability = 1f, WeenieClassId = 7, InitCreate = 1, MaxCreate = 1,
            WhenCreate = 0, WhereCreate = 0, PaletteTemplate = null,
        };
        string sql = AceDbConnector.GenerateGeneratorSql(99, new List<PlacementGenerator> { g })!;
        // palette_Id NULL (column 10) when no template index is set; obj_Cell_Id NULL (not 0) for a
        // null uint? spawn-loc, matching ACE WeenieSQLWriter.cs:780 + FixNullFields.
        Assert.Contains("NULL, 1, 1, 0, 0, NULL, NULL, NULL, NULL, ", sql);
    }

    // ── 4. Conflict handling (HARD CONSTRAINT 4) ─────────────────────────

    [Fact]
    public void Exporter_SameWcidIdenticalEnrichment_CollapsesToOne() {
        var a = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
            Dye = SampleDye(),
        };
        var b = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 2, WeenieClassId = 1234,
            Dye = SampleDye(),  // identical
        };

        var bundle = EnrichmentSqlExporter.Build(new[] { a, b });
        Assert.Empty(bundle.Conflicts);
        Assert.NotNull(bundle.Palette);
        Assert.Equal(1, bundle.Palette!.WeenieCount); // collapsed
    }

    [Fact]
    public void Exporter_SameWcidConflictingDye_FlaggedAndSkipped_NotSilentlyPicked() {
        var a = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
            Dye = new PlacementDye { SubPaletteId = 0x04001111u, Offset = 0, Length = 8 },
        };
        var b = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 2, WeenieClassId = 1234,
            Dye = new PlacementDye { SubPaletteId = 0x04002222u, Offset = 0, Length = 8 }, // conflicts
        };

        var bundle = EnrichmentSqlExporter.Build(new[] { a, b });

        // Conflict surfaced (not silently resolved) and the palette table is NOT emitted for 1234.
        Assert.Single(bundle.Conflicts);
        Assert.Equal(1234u, bundle.Conflicts[0].WeenieClassId);
        Assert.Equal("weenie_properties_palette", bundle.Conflicts[0].Table);
        Assert.Null(bundle.Palette); // skipped — neither value was picked
    }

    [Fact]
    public void Exporter_ConflictIsPerFacet_NonConflictingTablesStillEmit() {
        // Two placements of one wcid: SAME generator, DIFFERENT shade. The generator emits; the
        // float (shade) table is skipped for the conflict.
        var a = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
            Dye = new PlacementDye { Shade = 0.1f },
            Generators = new List<PlacementGenerator> { SampleGenerator() },
        };
        var b = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 2, WeenieClassId = 1234,
            Dye = new PlacementDye { Shade = 0.9f },  // conflicts on shade only
            Generators = new List<PlacementGenerator> { SampleGenerator() }, // identical generator
        };

        var bundle = EnrichmentSqlExporter.Build(new[] { a, b });
        Assert.Single(bundle.Conflicts);
        Assert.Equal("weenie_properties_float", bundle.Conflicts[0].Table);
        Assert.Null(bundle.Float);           // shade skipped
        Assert.NotNull(bundle.Generator);    // generator still emitted
    }

    [Fact]
    public void Exporter_PlacementOverrideScope_IsSkippedNotMisrouted() {
        var over = new EnrichedPlacement {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
            Guid = 0x7000_0001u,
            Scope = EnrichmentScope.PlacementOverride,
            Dye = SampleDye(),
        };

        var bundle = EnrichmentSqlExporter.Build(new[] { over });
        Assert.Equal(1, bundle.PlacementOverrideSkipped);
        Assert.Null(bundle.Palette);  // not misrouted to a weenie table (that is PR3)
        Assert.False(bundle.HasAny);
    }

    [Fact]
    public void Exporter_DeterministicWcidOrdering() {
        // wcids must serialize ascending so the file is golden-stable regardless of input order.
        var p1 = new EnrichedPlacement { Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 50, Dye = SampleDye() };
        var p2 = new EnrichedPlacement { Kind = "outdoor", Landblock = 1, CellNumber = 2, WeenieClassId = 10, Dye = SampleDye() };

        var bA = EnrichmentSqlExporter.Build(new[] { p1, p2 });
        var bB = EnrichmentSqlExporter.Build(new[] { p2, p1 });
        Assert.Equal(bA.Palette!.Sql, bB.Palette!.Sql);
        // 10 appears before 50 in the file.
        Assert.True(bA.Palette!.Sql.IndexOf("object_Id` = 10;") < bA.Palette!.Sql.IndexOf("object_Id` = 50;"));
    }

    // ── 5. File-emit / dry-run path (no DB) ──────────────────────────────

    [Fact]
    public void WriteFiles_EmitsPerTableSqlPlusManifest_NoDb() {
        var placements = new List<EnrichedPlacement> {
            new EnrichedPlacement {
                Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
                Dye = SampleDye(),
                Generators = new List<PlacementGenerator> { SampleGenerator() },
                Positions = SamplePositions(),
            },
        };

        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr2_{System.Guid.NewGuid():N}");
        try {
            var (bundle, written, manifestPath) = EnrichmentSqlExporter.WriteFiles(dir, placements);

            // All five tables present and on disk.
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.PaletteSqlFileName)));
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.GeneratorSqlFileName)));
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.PositionSqlFileName)));
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.IntSqlFileName)));
            Assert.True(File.Exists(Path.Combine(dir, AceDbConnector.FloatSqlFileName)));
            Assert.True(File.Exists(manifestPath));
            Assert.Equal(5, written.Count);

            // The written palette SQL contains the golden block (header + DELETE + INSERT).
            // sub_Palette_Id is ACE-canonical decimal (67113524 == 0x04001234) with a hex crib.
            string palette = File.ReadAllText(Path.Combine(dir, AceDbConnector.PaletteSqlFileName));
            Assert.Contains("VALUES (1234, 67113524, 8, 16) /* sub_Palette_Id 0x04001234 */;", palette);

            // Manifest is deterministic JSON noting the tables + zero conflicts.
            string manifest = File.ReadAllText(manifestPath);
            Assert.Contains("\"scope\":\"ClassDefault\"", manifest);
            Assert.Contains("weenie_properties_palette", manifest);
            Assert.Contains("\"conflicts\":[]", manifest);
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void WriteFiles_FullPaletteFileIsBytePinned_HeaderCountSeparatorTrailingNewline() {
        // Pin the EXACT on-disk artifact a downstream import/diff consumes: the `-- …` header line,
        // the dynamic `-- N weenie(s)` count line, the blank-line separator after each block, and
        // the trailing newline — none of which the per-emitter goldens cover.
        var placements = new List<EnrichedPlacement> {
            new EnrichedPlacement {
                Kind = "outdoor", Landblock = 0xAB12, CellNumber = 1, WeenieClassId = 1234,
                Dye = new PlacementDye { SubPaletteId = 0x04001234u, Offset = 8, Length = 16 },
            },
        };
        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr2_full_{System.Guid.NewGuid():N}");
        try {
            EnrichmentSqlExporter.WriteFiles(dir, placements);
            string palette = File.ReadAllText(Path.Combine(dir, AceDbConnector.PaletteSqlFileName));

            const string expected =
                "-- ACME WorldBuilder E1: weenie_properties_palette (per-class enrichment, Option A)\n" +
                "-- 1 weenie(s)\n" +
                "\n" +
                "DELETE FROM `weenie_properties_palette` WHERE `object_Id` = 1234;\n" +
                "INSERT INTO `weenie_properties_palette` (`object_Id`, `sub_Palette_Id`, `offset`, `length`)\n" +
                "VALUES (1234, 67113524, 8, 16) /* sub_Palette_Id 0x04001234 */;\n" +
                "\n";
            Assert.Equal(expected, palette);
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void WriteFiles_MultiWcidFileIsBytePinned_AscendingBlocksAndCount() {
        // Two wcids → the file header count is "2 weenie(s)", blocks are ascending by wcid, and each
        // block is blank-line separated. Pins the multi-block assembly wrapper.
        var placements = new List<EnrichedPlacement> {
            new EnrichedPlacement { Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 50,
                Dye = new PlacementDye { SubPaletteId = 0x04000050u, Offset = 0, Length = 4 } },
            new EnrichedPlacement { Kind = "outdoor", Landblock = 1, CellNumber = 2, WeenieClassId = 10,
                Dye = new PlacementDye { SubPaletteId = 0x04000010u, Offset = 0, Length = 4 } },
        };
        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr2_multi_{System.Guid.NewGuid():N}");
        try {
            EnrichmentSqlExporter.WriteFiles(dir, placements);
            string palette = File.ReadAllText(Path.Combine(dir, AceDbConnector.PaletteSqlFileName));

            const string expected =
                "-- ACME WorldBuilder E1: weenie_properties_palette (per-class enrichment, Option A)\n" +
                "-- 2 weenie(s)\n" +
                "\n" +
                "DELETE FROM `weenie_properties_palette` WHERE `object_Id` = 10;\n" +
                "INSERT INTO `weenie_properties_palette` (`object_Id`, `sub_Palette_Id`, `offset`, `length`)\n" +
                "VALUES (10, 67108880, 0, 4) /* sub_Palette_Id 0x04000010 */;\n" +
                "\n" +
                "DELETE FROM `weenie_properties_palette` WHERE `object_Id` = 50;\n" +
                "INSERT INTO `weenie_properties_palette` (`object_Id`, `sub_Palette_Id`, `offset`, `length`)\n" +
                "VALUES (50, 67108944, 0, 4) /* sub_Palette_Id 0x04000050 */;\n" +
                "\n";
            Assert.Equal(expected, palette);
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Manifest_ConflictOrderIsDeterministic_RegardlessOfInputOrder() {
        // Two DISTINCT conflicting wcids. The conflict list ordering must NOT depend on the order the
        // caller enumerated placements, or the manifest dry-run artifact would flap run-to-run.
        EnrichedPlacement Dyed(uint wcid, uint sub) => new() {
            Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = wcid,
            Dye = new PlacementDye { SubPaletteId = sub, Offset = 0, Length = 8 },
        };
        var w10a = Dyed(10, 0x04001111u);
        var w10b = Dyed(10, 0x04002222u); // conflicts with w10a
        var w20a = Dyed(20, 0x04003333u);
        var w20b = Dyed(20, 0x04004444u); // conflicts with w20a

        var fwd = EnrichmentSqlExporter.Build(new[] { w10a, w10b, w20a, w20b });
        var rev = EnrichmentSqlExporter.Build(new[] { w20a, w20b, w10a, w10b });

        Assert.Equal(2, fwd.Conflicts.Count);
        Assert.Equal(2, rev.Conflicts.Count);
        // Sorted ascending by wcid regardless of input order.
        Assert.Equal(10u, fwd.Conflicts[0].WeenieClassId);
        Assert.Equal(20u, fwd.Conflicts[1].WeenieClassId);
        Assert.Equal(fwd.Conflicts[0].WeenieClassId, rev.Conflicts[0].WeenieClassId);
        Assert.Equal(fwd.Conflicts[1].WeenieClassId, rev.Conflicts[1].WeenieClassId);

        // And the written manifest JSON is byte-identical across input orders.
        var dirA = Path.Combine(Path.GetTempPath(), $"e1_pr2_mfA_{System.Guid.NewGuid():N}");
        var dirB = Path.Combine(Path.GetTempPath(), $"e1_pr2_mfB_{System.Guid.NewGuid():N}");
        try {
            var (_, _, mA) = EnrichmentSqlExporter.WriteFiles(dirA, new[] { w10a, w10b, w20a, w20b });
            var (_, _, mB) = EnrichmentSqlExporter.WriteFiles(dirB, new[] { w20a, w20b, w10a, w10b });
            Assert.Equal(File.ReadAllText(mA), File.ReadAllText(mB));
        } finally {
            if (Directory.Exists(dirA)) Directory.Delete(dirA, recursive: true);
            if (Directory.Exists(dirB)) Directory.Delete(dirB, recursive: true);
        }
    }

    [Fact]
    public void Emitters_NonFiniteFloats_NeverEmitNaNOrInfinityTokens() {
        // PR1's JSONL allows named float literals (NaN/Infinity), so a degenerate vector/quaternion
        // or Shade can reach the emitters. They must collapse to a valid numeric SQL literal (0),
        // never the bare tokens "NaN"/"Infinity" which MySQL would reject.
        var positions = new Dictionary<PositionType, PlacementPosition> {
            [PositionType.Home] = new PlacementPosition {
                ObjCellId = 1,
                OriginX = float.NaN, OriginY = float.PositiveInfinity, OriginZ = float.NegativeInfinity,
                AnglesW = 1f,
            },
        };
        string posSql = AceDbConnector.GeneratePositionSql(7, positions)!;
        Assert.DoesNotContain("NaN", posSql);
        Assert.DoesNotContain("Infinity", posSql);
        Assert.Contains("0x00000001, 0, 0, 0, 1, ", posSql);

        string shadeSql = AceDbConnector.GenerateShadeFloatSql(7, new PlacementDye { Shade = float.NaN })!;
        Assert.DoesNotContain("NaN", shadeSql);
        Assert.Contains("VALUES (7, 12, 0) /* Shade */;", shadeSql);

        var gen = new PlacementGenerator {
            Probability = float.NaN, WeenieClassId = 7, InitCreate = 1, MaxCreate = 1,
            WhenCreate = 0, WhereCreate = 0, OriginX = float.PositiveInfinity,
        };
        string genSql = AceDbConnector.GenerateGeneratorSql(9, new List<PlacementGenerator> { gen })!;
        Assert.DoesNotContain("NaN", genSql);
        Assert.DoesNotContain("Infinity", genSql);
    }

    [Fact]
    public void WriteFiles_IsPureFileEmit_NeverTouchesADb() {
        // The dry-run / file-emit path (SPEC PR2 acceptance: "performs no DB connection"). WriteFiles
        // has no DB dependency at all — calling it with NO connection settings configured still
        // succeeds and produces the artifacts, proving it never opens a live ACE DB.
        var placements = new List<EnrichedPlacement> {
            new EnrichedPlacement {
                Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 1234,
                Dye = SampleDye(),
            },
        };
        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr2_nodb_{System.Guid.NewGuid():N}");
        try {
            var (bundle, written, manifestPath) = EnrichmentSqlExporter.WriteFiles(dir, placements);
            Assert.True(bundle.HasAny);
            Assert.NotEmpty(written);
            Assert.True(File.Exists(manifestPath));
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void WriteFiles_NoEnrichment_WritesNoTableFiles_ButManifest() {
        var placements = new List<EnrichedPlacement> {
            new EnrichedPlacement { Kind = "outdoor", Landblock = 1, CellNumber = 1, WeenieClassId = 99 },
        };
        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr2_bare_{System.Guid.NewGuid():N}");
        try {
            var (bundle, written, manifestPath) = EnrichmentSqlExporter.WriteFiles(dir, placements);
            Assert.False(bundle.HasAny);
            Assert.Empty(written);
            Assert.True(File.Exists(manifestPath));
            Assert.False(File.Exists(Path.Combine(dir, AceDbConnector.PaletteSqlFileName)));
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }
}
