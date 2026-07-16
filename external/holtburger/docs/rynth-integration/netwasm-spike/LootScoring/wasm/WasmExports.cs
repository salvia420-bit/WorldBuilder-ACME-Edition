// [JSExport] surface for the LootScoring slice — single JSON boundary.
// Compiled only into the browser-wasm project (LootScoring.Wasm.csproj).
using System.Runtime.InteropServices.JavaScript;
using RynthNetwasm.LootScoring;

public partial class LootScoringExports
{
    // evaluateLoot(json) -> json : one item classification.
    // Input = LootInput, output = LootOutput (LootScoring.cs DTOs).
    [JSExport]
    internal static string EvaluateLoot(string inputJson)
        => LootScoring.EvaluateLootJson(inputJson);

    [JSExport]
    internal static string Version() => "loot-scoring-netwasm-1";
}

public class Program { public static void Main() { } }
