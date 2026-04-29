using WorldBuilder.Terminal;

namespace WorldBuilder.Tests;

public class TokenizeLineTests {
    [Fact]
    public void Plain_SplitsOnWhitespace() {
        var t = TerminalRepl.TokenizeLine("set-height 100 200 0.5 128");
        Assert.Equal(new[] { "set-height", "100", "200", "0.5", "128" }, t);
    }

    [Fact]
    public void QuotedPath_StripsBoundaryQuotes() {
        var t = TerminalRepl.TokenizeLine("load \"C:\\My Projects\\demo.wbproj\"");
        Assert.Equal(2, t.Length);
        Assert.Equal("load", t[0]);
        Assert.Equal("C:\\My Projects\\demo.wbproj", t[1]);
    }

    [Fact]
    public void JsonArrayWithoutSpaces_PreservesInnerQuotes() {
        var json = "[{\"modelId\":\"0x020000A7\",\"x\":100,\"y\":100,\"z\":0}]";
        var t = TerminalRepl.TokenizeLine($"bulk-place-objects 7 16 {json}");
        Assert.Equal(4, t.Length);
        Assert.Equal(json, t[3]);
    }

    [Fact]
    public void JsonArrayWithInnerSpaces_StaysOneToken() {
        var json = "[{\"a\": 1, \"b\": [2, 3]}]";
        var t = TerminalRepl.TokenizeLine($"cmd {json}");
        Assert.Equal(2, t.Length);
        Assert.Equal(json, t[1]);
    }

    [Fact]
    public void NestedBrackets_AreBalanced() {
        var t = TerminalRepl.TokenizeLine("cmd [[1, 2], [3, 4]] tail");
        Assert.Equal(3, t.Length);
        Assert.Equal("[[1, 2], [3, 4]]", t[1]);
        Assert.Equal("tail", t[2]);
    }
}
