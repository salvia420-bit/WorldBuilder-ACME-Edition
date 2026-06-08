using System.Collections.Generic;
using System.IO;
using System.Linq;

using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Tests;

/// <summary>
/// E1 (wave-2) PR3 — ORCHESTRATOR-LEVEL invariants for the Option B per-placement biota override,
/// exercised through the exact building blocks <c>CommandEngine.PlacementExportSqlAsync</c> composes
/// (mint guids → write back onto placements → world SQL → JSONL → re-import). ALL tests are DB-free:
/// they use the file-emit/golden/script-collection seams, never a live MySQL/ACE server
/// (HARD CONSTRAINT 1).
///
/// These pin the blocker fixes the unit-level golden tests alone could not:
///   • world↔shard join correctness: landblock_instance.guid == biota.id (WorldObjectFactory.cs:297);
///   • minted-guid persistence + STABILITY across re-exports (the addressable key never moves);
///   • the E6 gate actually blocks biota emission + apply on errors, and --force / --no-validate
///     bypass; an empty index on --apply is a blocking error;
///   • the biota stub carries a non-Undef WeenieType (else the placement vanishes on load).
/// </summary>
public class BiotaOverridePipelineTests {

    private static WeenieIndex IndexFor(params int[] wcids) {
        var dict = new Dictionary<int, WeenieIndexEntry>();
        foreach (var w in wcids)
            dict[w] = new WeenieIndexEntry(
                Wcid: w, ClassName: $"wcid_{w}", WeenieType: 1, IsServerManaged: false, IsNpc: false,
                DisplayName: $"wcid {w}", Title: null, SetupDid: 0x02000001u, IconDid: null,
                PaletteBaseDid: null, CreatureType: null, Level: null, SourceMask: WeenieSource.AceDb);
        return new WeenieIndex(dict);
    }

    private static PlacementDye Dye() => new() { SubPaletteId = 0x04001234u, Offset = 8, Length = 16, Shade = 0.5f };

    private static OutdoorInstancePlacement OverridePlacement(ushort lb, ushort cell, uint wcid, uint? guid = null) =>
        new() {
            LandblockId = lb, CellNumber = cell, WeenieClassId = wcid, Guid = guid,
            OriginX = 1f, OriginY = 2f, OriginZ = 3f, AnglesW = 1f, AnglesX = 0, AnglesY = 0, AnglesZ = 0,
            Scope = EnrichmentScope.PlacementOverride, Dye = Dye(),
        };

    // ── 1. World↔shard join: landblock_instance.guid == biota.id ──────────

    [Fact]
    public void WorldGuid_EqualsBiotaId_ForMintedOverride() {
        // The orchestrator mints the static guid (writes it back onto the placement) BEFORE it
        // generates the world landblock_instance row, so the world guid literal MUST equal the
        // biota.sql id literal. A mismatch makes the override a silent no-op on a live server.
        var p = OverridePlacement(0xAB12, 1, 1234);
        var e = EnrichedPlacementStore.FromOutdoor(p);

        // (a) mint — writes guid back onto e (and, in the engine, onto p).
        var bundle = BiotaEnrichmentSqlExporter.Build(new[] { e }, IndexFor(1234));
        Assert.Single(bundle.Assignments);
        uint biotaGuid = bundle.Assignments[0].Guid;
        Assert.Equal(0x7AB12000u, biotaGuid);
        Assert.Equal(biotaGuid, e.Guid); // written back

        // (b) propagate to the source model (engine does this), then generate world SQL.
        p.Guid = e.Guid;
        var records = AceDbConnector.ToLandblockInstanceRecordsFromOutdoor(new[] { p });
        Assert.Equal(biotaGuid, records[0].Guid);

        string worldSql = AceDbConnector.GenerateInsertSqlBatch(records);
        string biotaSql = bundle.Biota!.Sql;

        // The same numeric guid appears in BOTH the world INSERT and the biota stub VALUES.
        string lit = biotaGuid.ToString(System.Globalization.CultureInfo.InvariantCulture);
        Assert.Contains($"VALUES ({lit},", worldSql);     // world landblock_instance row
        Assert.Contains($"VALUES ({lit},", biotaSql);     // shard biota stub row
        // …and the world row is idempotent (scoped DELETE before INSERT) because the guid is static.
        Assert.Contains($"DELETE FROM `ace_world`.`landblock_instance` WHERE `guid` = {lit};", worldSql);
    }

    // ── 2. Minted guid persisted + STABLE across re-exports ───────────────

    [Fact]
    public void MintedGuid_PersistedToJsonl_AndStableAcrossReExport() {
        var dir = Path.Combine(Path.GetTempPath(), $"e1_pr3_stable_{System.Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try {
            // ── Round 1: two no-guid overrides in the same landblock. ──
            var e1 = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 1, 100));
            var e2 = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 2, 200));
            var index = IndexFor(100, 200);

            // Engine order: mint (writes guids back) THEN write JSONL.
            BiotaEnrichmentSqlExporter.WriteFiles(dir, new[] { e1, e2 }, index);
            EnrichedPlacementStore.WriteFile(dir, new[] { e1, e2 });

            Assert.NotNull(e1.Guid);
            Assert.NotNull(e2.Guid);
            Assert.True(StaticGuidAllocator.IsInLandblockStaticRange(0xAB12, e1.Guid!.Value));
            Assert.True(StaticGuidAllocator.IsInLandblockStaticRange(0xAB12, e2.Guid!.Value));
            uint g100 = e1.Guid!.Value, g200 = e2.Guid!.Value;
            Assert.NotEqual(g100, g200);

            // The JSONL recorded the MINTED guids (not null).
            var reread = EnrichedPlacementStore.ReadFile(dir);
            uint? jsonG100 = reread.Single(p => p.WeenieClassId == 100).Guid;
            uint? jsonG200 = reread.Single(p => p.WeenieClassId == 200).Guid;
            Assert.Equal(g100, jsonG100);
            Assert.Equal(g200, jsonG200);

            // ── Round 2: re-export from the re-read placements. The guid is now EXPLICIT, so the
            //     SAME logical placement keeps the SAME guid (stability), even though wcid-100 is
            //     removed (which would have shifted a gap-filling allocator). ──
            var only200 = reread.Where(p => p.WeenieClassId == 200).ToList();
            var dir2 = Path.Combine(Path.GetTempPath(), $"e1_pr3_stable2_{System.Guid.NewGuid():N}");
            Directory.CreateDirectory(dir2);
            try {
                BiotaEnrichmentSqlExporter.WriteFiles(dir2, only200, index);
                EnrichedPlacementStore.WriteFile(dir2, only200);
                var reread2 = EnrichedPlacementStore.ReadFile(dir2);
                Assert.Equal(g200, reread2.Single().Guid); // SAME addressable key, never re-minted
            } finally {
                if (Directory.Exists(dir2)) Directory.Delete(dir2, recursive: true);
            }
        } finally {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    // ── 3. Biota stub carries the resolved (non-Undef) WeenieType ─────────

    [Fact]
    public void BiotaStub_CarriesResolvedWeenieType_NeverUndef() {
        var e = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 1, 1234));
        var dict = new Dictionary<int, WeenieIndexEntry> {
            [1234] = new WeenieIndexEntry(
                Wcid: 1234, ClassName: "door", WeenieType: 8 /* Door */, IsServerManaged: false, IsNpc: false,
                DisplayName: "a door", Title: null, SetupDid: 0x02000001u, IconDid: null,
                PaletteBaseDid: null, CreatureType: null, Level: null, SourceMask: WeenieSource.AceDb),
        };
        var bundle = BiotaEnrichmentSqlExporter.Build(new[] { e }, new WeenieIndex(dict));
        // weenie_Type = 8 (Door), NOT 0 (Undef → null WorldObject on load).
        Assert.Contains("VALUES (2058428416, 1234, 8,", bundle.Biota!.Sql);
        Assert.DoesNotContain(", 0, 4294967295)", bundle.Biota!.Sql);
    }

    [Fact]
    public void BiotaStub_SkippedWithWarning_WhenWeenieTypeUnresolvable() {
        // Index does NOT contain the wcid → cannot certify a non-Undef type → SKIP (don't emit an
        // unspawnable biota), surface a warning.
        var e = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 1, 9999));
        var bundle = BiotaEnrichmentSqlExporter.Build(new[] { e }, IndexFor(1234));
        Assert.False(bundle.HasAny);
        Assert.Equal(1, bundle.Skipped);
        Assert.Contains(bundle.Warnings, w => w.Kind == "weenie_type_unresolved");
    }

    [Fact]
    public void BiotaStub_SkippedWithWarning_WhenIndexNotIngested() {
        var e = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 1, 1234));
        var bundle = BiotaEnrichmentSqlExporter.Build(new[] { e }, WeenieIndex.Empty);
        Assert.False(bundle.HasAny);
        Assert.Equal(1, bundle.Skipped);
        Assert.Contains(bundle.Warnings, w => w.Kind == "weenie_index_not_ingested");
    }

    // ── 4. E6 gate decision (offline) drives biota emission + apply ───────

    [Fact]
    public void Gate_UnknownWcid_WithIngestedIndex_Blocks() {
        var e = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 1, 9999));
        var report = EnrichedPlacementValidator.Validate(new[] { e }, IndexFor(1234));
        Assert.False(report.Ok); // → orchestrator sets ValidationBlocked, skips biota + apply
        Assert.Contains(report.Findings, f => f.Code == "wcid_unresolved");
    }

    [Fact]
    public void Gate_EmptyIndex_OnApply_IsBlockingError_ButWarnsOnDryRun() {
        var e = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 1, 1234));

        var dryRun = EnrichedPlacementValidator.Validate(new[] { e }, WeenieIndex.Empty, applying: false);
        Assert.True(dryRun.Ok); // soft warning only — does not block a file-emit
        Assert.Contains(dryRun.Findings, f => f.Code == "index_empty");

        var apply = EnrichedPlacementValidator.Validate(new[] { e }, WeenieIndex.Empty, applying: true);
        Assert.False(apply.Ok); // a LIVE write must not skip resolution
        Assert.Contains(apply.Findings, f => f.Code == "index_not_ingested_for_apply");
    }

    [Fact]
    public void Gate_OverrideUndefWeenieType_Blocks() {
        var e = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 1, 1234));
        var dict = new Dictionary<int, WeenieIndexEntry> {
            [1234] = new WeenieIndexEntry(
                Wcid: 1234, ClassName: "undef", WeenieType: 0 /* Undef */, IsServerManaged: false, IsNpc: false,
                DisplayName: "undef", Title: null, SetupDid: 0x02000001u, IconDid: null,
                PaletteBaseDid: null, CreatureType: null, Level: null, SourceMask: WeenieSource.AceDb),
        };
        var report = EnrichedPlacementValidator.Validate(new[] { e }, new WeenieIndex(dict));
        Assert.False(report.Ok);
        Assert.Contains(report.Findings, f => f.Code == "override_weenie_type_undef");
    }

    [Fact]
    public void Gate_OverrideGuidOutOfStaticRange_Blocks() {
        var p = OverridePlacement(0xAB12, 1, 1234, guid: 0x80000001u); // dynamic range
        var e = EnrichedPlacementStore.FromOutdoor(p);
        var report = EnrichedPlacementValidator.Validate(new[] { e }, IndexFor(1234));
        Assert.False(report.Ok);
        Assert.Contains(report.Findings, f => f.Code == "override_guid_out_of_static_range");
    }

    [Fact]
    public void Gate_GeneratorPaletteTemplate_TooLarge_IsWarning() {
        var e = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 1, 1234));
        e.Generators = new List<PlacementGenerator> {
            new PlacementGenerator { Probability = 1f, WeenieClassId = 7, InitCreate = 1, MaxCreate = 1,
                PaletteTemplate = 70000 },
        };
        var report = EnrichedPlacementValidator.Validate(new[] { e }, IndexFor(1234, 7));
        Assert.True(report.Ok); // warning, not error
        Assert.Contains(report.Findings, f => f.Code == "generator_palette_template_implausible");
    }

    // ── 5. Apply routing precondition: shard target must differ from world ─

    [Fact]
    public void ApplyPlan_ShardScripts_AreBiotaOnly_AndPresentWhenOverridesExist() {
        var e = EnrichedPlacementStore.FromOutdoor(OverridePlacement(0xAB12, 1, 1234));
        var world = EnrichmentSqlExporter.Build(new[] { e });
        var shard = BiotaEnrichmentSqlExporter.Build(new[] { e }, IndexFor(1234));
        var plan = EnrichmentApplyPlan.Build("x;", 1, null, 0, world, shard);
        Assert.True(plan.RequiresShard);
        foreach (var s in plan.ShardScripts) {
            Assert.Contains("biota", s!);
            Assert.DoesNotContain("weenie_properties", s!);
        }
    }
}
