using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using WorldBuilder.Terminal;
using Xunit;

namespace WorldBuilder.Tests;

/// <summary>
/// The REPL runs JSON-only commands as <c>name key=value ...</c> or <c>name {json}</c>.
/// </summary>
public class ReplJsonFallbackTests {
    private static TerminalRepl NewRepl() =>
        new(new HeadlessProjectManager(NullLoggerFactory.Instance), null!, null!, null!, null!, null!);

    private static JsonElement Request(string line) {
        var json = NewRepl().BuildJsonRequest(TerminalRepl.TokenizeLine(line));
        Assert.NotNull(json);
        return JsonDocument.Parse(json!).RootElement;
    }

    [Fact]
    public void KeyValueArguments_BecomeTypedJsonFields() {
        var r = Request("render-dungeon lbX=169 lbY=180 includePng=true outputPath=/tmp/d.png");
        Assert.Equal("render-dungeon", r.GetProperty("command").GetString());
        Assert.Equal(169, r.GetProperty("lbX").GetInt32());
        Assert.True(r.GetProperty("includePng").GetBoolean());
        Assert.Equal("/tmp/d.png", r.GetProperty("outputPath").GetString());
    }

    [Fact]
    public void HexAndQuotedValues_StayStrings() {
        var r = Request("chorizite-parse-dat-record idHex=0x08000000 typeName=\"Surface\"");
        Assert.Equal("0x08000000", r.GetProperty("idHex").GetString());
        Assert.Equal("Surface", r.GetProperty("typeName").GetString());
    }

    [Fact]
    public void JsonObjectArgument_IsMergedAndCannotOverrideCommand() {
        var r = Request("cell-portal-graph-sweep {\"lbIds\": [\"0xA9B4\", 43444], \"command\": \"export\"}");
        Assert.Equal("cell-portal-graph-sweep", r.GetProperty("command").GetString());
        Assert.Equal(2, r.GetProperty("lbIds").GetArrayLength());
    }

    [Fact]
    public void ArrayValue_StaysOneToken() {
        var r = Request("generate-object-sprites lbFilter=[\"0xA9B4\", \"0xA9B5\"] spritePx=256");
        Assert.Equal(2, r.GetProperty("lbFilter").GetArrayLength());
        Assert.Equal(256, r.GetProperty("spritePx").GetInt32());
    }

    [Fact]
    public void PositionalArgument_IsRejectedWithAHint() {
        var ex = Assert.Throws<ArgumentException>(() =>
            NewRepl().BuildJsonRequest(TerminalRepl.TokenizeLine("render-dungeon 169 180")));
        Assert.Contains("key=value", ex.Message);
    }

    [Fact]
    public void NonJsonCommand_IsNotRouted() {
        Assert.Null(NewRepl().BuildJsonRequest(TerminalRepl.TokenizeLine("no-such-command a=1")));
    }
}
