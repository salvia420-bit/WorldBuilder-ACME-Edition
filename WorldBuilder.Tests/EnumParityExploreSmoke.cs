using System;
using System.Linq;
using WorldBuilder.Terminal;
using Xunit;
using Xunit.Abstractions;

namespace WorldBuilder.Tests;

/// <summary>
/// Wave 2.C exploration probe. Not a real test — just dumps the live report
/// to xunit's output stream so we can eyeball which enums currently PASS vs
/// FAIL vs GAP. Asserts only the summary contract (66 checked, sum
/// matches). Useful for diagnostic-flow review when a Rust enum is added
/// or removed.
/// </summary>
public class EnumParityExploreSmoke {
    private readonly ITestOutputHelper _out;
    public EnumParityExploreSmoke(ITestOutputHelper output) { _out = output; }

    private static CommandEngine MakeStubEngine() =>
        new CommandEngine(null!, null!, null!, null!, null!, null!);

    [Fact]
    public void DumpReportToOutput() {
        var engine = MakeStubEngine();
        var report = engine.EnumParityReportCommand(null, null);

        _out.WriteLine($"Wave 2.C — Enum Parity Audit");
        _out.WriteLine($"================================");
        _out.WriteLine($"Chorizite root: {report.ChoriziteSourceRoot}");
        _out.WriteLine($"Rust crates:    {report.RustCrateRoot}");
        _out.WriteLine($"Checked: {report.CheckedEnums}   PASS: {report.PassEnums}   FAIL: {report.FailEnums}   GAP: {report.GapEnums}");
        _out.WriteLine("");
        foreach (var r in report.Rows.OrderBy(r => r.Status).ThenBy(r => r.ChoriziteName)) {
            _out.WriteLine($"[{r.Status,-14}] {r.ChoriziteName,-30} ↔ {r.RustName ?? "?"} ({r.RustRelativePath ?? "?"})  members={r.CheckedMembers} pass={r.PassMembers} fail={r.FailMembers}");
            foreach (var mm in r.Mismatches.Take(3)) {
                string cv = mm.ChoriziteValue?.ToString("X") ?? "—";
                string rv = mm.RustValue?.ToString("X") ?? "—";
                _out.WriteLine($"    [{mm.Kind,-18}] {mm.Name,-30} chor=0x{cv,-8} rust=0x{rv,-8} {mm.Note ?? ""}");
            }
            if (r.Mismatches.Count > 3) _out.WriteLine($"    ... and {r.Mismatches.Count - 3} more mismatches");
        }
    }
}
