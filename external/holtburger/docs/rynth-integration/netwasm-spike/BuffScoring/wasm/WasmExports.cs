// [JSExport] surface for the BuffScoring slice — single JSON boundary.
// Compiled only into the browser-wasm project (BuffScoring.Wasm.csproj).
using System.Runtime.InteropServices.JavaScript;
using RynthNetwasm.BuffScoring;

public partial class BuffScoringExports
{
    // scheduleBuffs(json) -> json : one buff heartbeat.
    // Input = BuffInput, output = BuffOutput (BuffScheduling.cs DTOs).
    [JSExport]
    internal static string ScheduleBuffs(string inputJson)
        => BuffScheduling.ScheduleBuffsJson(inputJson);

    [JSExport]
    internal static string Version() => "buff-scoring-netwasm-1";
}

public class Program { public static void Main() { } }
