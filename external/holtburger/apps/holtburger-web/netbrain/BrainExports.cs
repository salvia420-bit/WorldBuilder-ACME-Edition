// Unified [JSExport] surface for the RynthBrain .NET-wasm slices — one AppBundle,
// one export class, same single-JSON boundaries as the per-slice spike projects
// (docs/rynth-integration/netwasm-spike/*/wasm/WasmExports.cs).
using System.Runtime.InteropServices.JavaScript;
using RynthNetwasm.BuffScoring;
using RynthNetwasm.CombatScoring;
using RynthNetwasm.LootScoring;

public partial class RynthBrainExports
{
    // scoreTargets(json) -> json : one combat target-selection tick.
    // Input = ScoringInput, output = ScoringOutput (TargetScoring.cs DTOs).
    [JSExport]
    internal static string ScoreTargets(string inputJson)
        => TargetScoring.ScoreTargetsJson(inputJson);

    // scheduleBuffs(json) -> json : one buff heartbeat.
    // Input = BuffInput, output = BuffOutput (BuffScheduling.cs DTOs).
    [JSExport]
    internal static string ScheduleBuffs(string inputJson)
        => BuffScheduling.ScheduleBuffsJson(inputJson);

    // evaluateLoot(json) -> json : one item classification.
    // Input = LootInput, output = LootOutput (LootScoring.cs DTOs).
    [JSExport]
    internal static string EvaluateLoot(string inputJson)
        => LootScoring.EvaluateLootJson(inputJson);

    [JSExport]
    internal static string Version() => "rynth-netbrain-2";
}

public class Program { public static void Main() { } }
