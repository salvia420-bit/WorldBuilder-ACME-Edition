using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using WorldBuilder.Terminal;
using Xunit;

namespace WorldBuilder.Tests;

/// <summary>Tests that swap the process-wide Console streams must not run beside other tests.</summary>
[CollectionDefinition("Console", DisableParallelization = true)]
public class ConsoleCollection { }

[Collection("Console")]
public class StdinLoopTests {
    /// <summary>Feeds lines to the stdin loop; prints a stray line to Console.Out before the second one,
    /// the way a library helper (e.g. DatExportFixer during export) would mid-session.</summary>
    private sealed class ScriptedStdin(params string[] lines) : TextReader {
        private int _next;
        public override string? ReadLine() {
            if (_next == 1) Console.WriteLine("[SomeHelper] stray diagnostic on Console.Out");
            return _next < lines.Length ? lines[_next++] : null;
        }
    }

    [Fact]
    public void StdoutCarriesOnlyProtocolLines() {
        var processor = new JsonCommandProcessor(
            new HeadlessProjectManager(NullLoggerFactory.Instance), null!, null!, null!, null!, null!);
        TextReader origIn = Console.In;
        TextWriter origOut = Console.Out, origErr = Console.Error;
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        try {
            Console.SetIn(new ScriptedStdin("""{"command":"info"}""", """{"command":"help"}""", """{"command":"quit"}"""));
            Console.SetOut(stdout);
            Console.SetError(stderr);
            processor.RunStdinLoop();
        } finally {
            Console.SetIn(origIn);
            Console.SetOut(origOut);
            Console.SetError(origErr);
        }

        var lines = stdout.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        // ready + info + help + quit, each one JSON object per line
        Assert.Equal(4, lines.Length);
        foreach (var line in lines) {
            using var doc = JsonDocument.Parse(line);
            Assert.True(doc.RootElement.TryGetProperty("command", out _));
        }
        Assert.Contains("stray diagnostic", stderr.ToString());
    }
}
