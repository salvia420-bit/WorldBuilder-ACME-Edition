// [JSExport] surface for the CombatScoring slice — single JSON boundary.
// Compiled only into the browser-wasm project (CombatScoring.Wasm.csproj).
using System.Runtime.InteropServices.JavaScript;
using RynthNetwasm.CombatScoring;

public partial class CombatScoringExports
{
    // scoreTargets(json) -> json : one selection tick.
    // Input = ScoringInput, output = ScoringOutput (TargetScoring.cs DTOs).
    [JSExport]
    internal static string ScoreTargets(string inputJson)
        => TargetScoring.ScoreTargetsJson(inputJson);

    [JSExport]
    internal static string Version() => "combat-scoring-netwasm-1";
}

public class Program { public static void Main() { } }
