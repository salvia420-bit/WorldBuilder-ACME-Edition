using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using WorldBuilder.Terminal;
using Xunit;

namespace WorldBuilder.Tests;

/// <summary>
/// Contract checks for the --stdin JSON protocol that need no project and no DATs,
/// so they run anywhere (including CI).
/// </summary>
public class JsonProtocolContractTests {
    private static JsonCommandProcessor NewProcessor() =>
        new(new HeadlessProjectManager(NullLoggerFactory.Instance), null!, null!, null!, null!, null!);

    private static JsonElement Run(JsonCommandProcessor p, string json) =>
        JsonDocument.Parse(p.ProcessCommand(json)).RootElement;

    private static HashSet<string> HelpNames(JsonCommandProcessor p) {
        var help = Run(p, """{"command":"help"}""");
        Assert.True(help.GetProperty("success").GetBoolean());
        return help.GetProperty("commands").EnumerateArray()
            .Select(c => c.GetProperty("name").GetString()!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public void Help_ListsEveryDispatchedCommand() {
        var p = NewProcessor();
        var help = HelpNames(p);
        var undocumented = p.CommandNames.Where(n => !help.Contains(n)).OrderBy(n => n).ToList();
        Assert.True(undocumented.Count == 0,
            "Commands dispatched but missing from help: " + string.Join(", ", undocumented));
    }

    [Fact]
    public void Help_ListsNoCommandThatIsNotDispatched() {
        var p = NewProcessor();
        var dispatched = p.CommandNames.ToHashSet(StringComparer.OrdinalIgnoreCase);
        // quit/exit are handled by the stdin loop itself, before dispatch.
        var orphans = HelpNames(p).Where(n => n != "quit" && !dispatched.Contains(n)).OrderBy(n => n).ToList();
        Assert.True(orphans.Count == 0, "Help entries with no handler: " + string.Join(", ", orphans));
    }

    [Fact]
    public void Info_WithoutProject_SucceedsAndReportsNotLoaded() {
        var r = Run(NewProcessor(), """{"command":"info"}""");
        Assert.True(r.GetProperty("success").GetBoolean());
        Assert.False(r.GetProperty("loaded").GetBoolean());
    }

    [Fact]
    public void UnknownCommand_FailsWithError() {
        var r = Run(NewProcessor(), """{"command":"no-such-command"}""");
        Assert.False(r.GetProperty("success").GetBoolean());
        Assert.Contains("Unknown command", r.GetProperty("error").GetString());
    }

    [Fact]
    public void Failures_AlwaysCarryAnError() {
        // A project-requiring command without a project must fail loudly, with an error.
        var r = Run(NewProcessor(), """{"command":"terrain-info","lbX":1,"lbY":1}""");
        Assert.False(r.GetProperty("success").GetBoolean());
        Assert.False(string.IsNullOrWhiteSpace(r.GetProperty("error").GetString()));
    }
}
