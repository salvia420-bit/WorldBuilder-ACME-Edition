using System;
using System.Runtime.InteropServices.JavaScript;

// Island-excised brain slice: the RynthAi target-scoring shape,
// dependency-free (no Marshal, no threads, no Win32). This is the
// D1 fork test — does the debugged C# LOGIC compile to browser wasm?
public partial class BrainSlice
{
    // Mirrors report 11's utility-AI scoring: nearer = higher, plus the
    // opt-in monster-rule priority term (Priority-1)*5.
    [JSExport]
    internal static double ScoreTarget(double distance, int priority, int healthPercent)
    {
        double baseScore = Math.Max(0.0, 100.0 - distance);
        double priorityTerm = Math.Max(0, priority - 1) * 5.0;
        // Prefer wounded targets slightly (finish them).
        double woundBonus = healthPercent < 50 ? 3.0 : 0.0;
        return baseScore + priorityTerm + woundBonus;
    }

    // Report 11 P3 face-settle gate, pure arithmetic.
    [JSExport]
    internal static bool ShouldSettleBeforeCast(double facingErrorDeg, double faceToleranceDeg)
        => facingErrorDeg > faceToleranceDeg;

    [JSExport]
    internal static string Version() => "brain-slice-netwasm-1";
}

public class Program { public static void Main() { } }
