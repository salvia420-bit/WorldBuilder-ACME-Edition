using System.Linq;
using WorldBuilder.Terminal;
using Xunit;

namespace WorldBuilder.Tests;

/// <summary>
/// Wave 2.C smoke tests for <c>CommandEngine.EnumParityReportCommand</c>.
/// Uses a CommandEngine instance with null services because parity logic
/// only touches Chorizite reflection + filesystem-scanned Rust source —
/// no project, terrain, ontology, etc.
/// </summary>
public class EnumParityTests {

    private static CommandEngine MakeStubEngine() {
        // Services are unused by the parity command path. Cast to null! is
        // a deliberate signal that this engine is only safe for Chorizite +
        // EnumParity calls; do not extend this test to use anything else
        // without wiring real services.
        return new CommandEngine(
            projectManager: null!,
            terrainService: null!,
            objectPlacementService: null!,
            dungeonService: null!,
            ontologyService: null!,
            stampService: null!);
    }

    [Fact]
    public void Dumps_All_65_CuratedEnums_Plus_ObjectDescriptionFlag() {
        var engine = MakeStubEngine();
        var dumps = engine.ChoriziteDumpEnumValues(null);
        // Curated allowlist (Wave 2.C expanded to all 65 Chorizite.Common
        // enums + ObjectDescriptionFlag from ACProtocol).
        Assert.Equal(66, dumps.Count);
        Assert.Contains(dumps, d => d.EnumName == "AttackHeight");
        Assert.Contains(dumps, d => d.EnumName == "ObjectDescriptionFlag");
        Assert.Contains(dumps, d => d.EnumName == "WieldType");
        // Smoke-check large + small enums.
        var spellCategory = dumps.FirstOrDefault(d => d.EnumName == "SpellCategory");
        Assert.NotNull(spellCategory);
        Assert.True(spellCategory!.Members.Count > 700, $"SpellCategory should have ~729 members, got {spellCategory.Members.Count}");
    }

    [Fact]
    public void EnumParityReport_Returns_Structured_Diff() {
        var engine = MakeStubEngine();
        var report = engine.EnumParityReportCommand(sourceRoot: null, rustCrateRoot: null);

        // 66 enums checked (65 Chorizite.Common + ObjectDescriptionFlag).
        Assert.Equal(66, report.CheckedEnums);
        // Every row should have a status.
        Assert.All(report.Rows, r => Assert.False(string.IsNullOrEmpty(r.Status)));
        // The well-known same-name enums should be PASS or FAIL (not missing).
        var attackHeight = report.Rows.FirstOrDefault(r => r.ChoriziteName == "AttackHeight");
        Assert.NotNull(attackHeight);
        Assert.NotEqual("missing-rust", attackHeight!.Status);
        // AttackHeight has 3 variants matching across the two ports.
        Assert.Equal(3, attackHeight.CheckedMembers);

        // Counters should sum.
        Assert.Equal(report.CheckedEnums, report.PassEnums + report.FailEnums + report.GapEnums);
    }

    [Fact]
    public void Diff_Reports_Bitflag_Cases_As_Missing_Rust() {
        var engine = MakeStubEngine();
        var report = engine.EnumParityReportCommand(sourceRoot: null, rustCrateRoot: null);

        // ItemType is a [Flags] enum in Chorizite. We use bitflags!
        // macro-generated struct in Rust, so there's no `pub enum ItemType`
        // counterpart — this should report missing-rust.
        var itemType = report.Rows.FirstOrDefault(r => r.ChoriziteName == "ItemType");
        Assert.NotNull(itemType);
        Assert.Equal("missing-rust", itemType!.Status);
    }
}
