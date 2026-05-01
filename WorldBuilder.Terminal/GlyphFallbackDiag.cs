using System.Collections.Concurrent;
using System.Text;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

/// <summary>
/// Per-render counter of objects that fell back to glyph rendering
/// because no sprite was available. Groups by ontology bucket
/// (Architecture, Category, Scale, source) so a clustered report tells
/// us "47 'Aluvian / Stone / Medium' setupIds have no sprite" rather
/// than dumping one line per object.
///
/// The fallback is the renderer's last resort: when the sprite atlas
/// has no entry for an object's setupId (placed) or the wcid resolver
/// returns 0 / no atlas hit (spawn), we draw a coloured glyph instead.
/// That's correct behaviour, but the X / square / ring shapes hide what
/// the object actually is — and most of them are missing because the
/// sprite generator's <c>TriangulateModel</c> returned no triangles, the
/// model is a stub placeholder, or the Z-dominance heuristic produced
/// an empty bitmap. This diagnostic surfaces those clusters so we can
/// route them through targeted ontology fixes (e.g. an enrichment
/// pass for the cluster, a custom sprite generator for stub meshes,
/// a category-specific glyph that's less obtrusive).
///
/// Usage from CommandEngine:
///   GlyphFallbackDiag.Reset();        // start of a render batch
///   ... renders happen, dispatcher calls GlyphFallbackDiag.Note ...
///   var report = GlyphFallbackDiag.Report();
///   File.WriteAllText("glyph_fallback.txt", report);
///
/// Concurrency-safe: ConcurrentDictionary plus interlocked counters
/// in case parallel emits land here from different LBs.
/// </summary>
internal static class GlyphFallbackDiag {

    public sealed class Bucket {
        public long Count;
        public readonly object SampleLock = new();
        public readonly List<uint> SampleIds = new(SampleIdCap);
        public readonly HashSet<string>? SampleNames = new();
    }

    /// <summary>How many distinct setupIds to remember per bucket.
    /// Enough to seed a follow-up ontology query without flooding
    /// memory across a full-world emit.</summary>
    private const int SampleIdCap = 32;

    public enum Source { Placed, Spawn }

    private static readonly ConcurrentDictionary<(string arch, string cat, string scale, Source src), Bucket> _buckets = new();

    /// <summary>
    /// Note that <paramref name="setupId"/> fell to glyph fallback. The
    /// optional <paramref name="entry"/> drives bucket selection. When
    /// the entry is missing (no ontology coverage), the object lands in
    /// the <c>?/?/?</c> bucket — that's a useful signal in itself.
    /// </summary>
    public static void Note(uint setupId, OntologyEntry? entry, Source source) {
        var key = (
            entry?.Architecture ?? "?",
            entry?.Category ?? "?",
            entry?.Scale ?? "?",
            source);
        var b = _buckets.GetOrAdd(key, _ => new Bucket());
        Interlocked.Increment(ref b.Count);
        // Sample retention: bounded so memory stays small under a full-
        // world emit with millions of glyph fallbacks.
        if (b.SampleIds.Count < SampleIdCap) {
            lock (b.SampleLock) {
                if (b.SampleIds.Count < SampleIdCap && !b.SampleIds.Contains(setupId)) {
                    b.SampleIds.Add(setupId);
                    if (entry?.Name is { Length: > 0 } name) {
                        b.SampleNames!.Add(name);
                    }
                }
            }
        }
    }

    public static void Reset() => _buckets.Clear();

    /// <summary>
    /// Render-summary report. Buckets sorted by descending count so the
    /// largest "missing sprite" clusters land at the top — those are
    /// the ones worth spending ontology / sprite-gen effort on first.
    /// </summary>
    public static string Report() {
        if (_buckets.IsEmpty) return "[GlyphFallback] no fallbacks recorded\n";
        var sb = new StringBuilder();
        long total = 0;
        foreach (var kv in _buckets) total += Interlocked.Read(ref kv.Value.Count);
        sb.AppendLine($"[GlyphFallback] {total:N0} object draws fell back to glyph (no sprite)");
        sb.AppendLine($"[GlyphFallback] {_buckets.Count:N0} ontology buckets, sorted by descending count:");
        sb.AppendLine();
        // Header
        sb.AppendLine($"  {"count",8}  {"src",6}  {"architecture",-22}  {"category",-18}  {"scale",-10}  sample setupIds / names");
        sb.AppendLine($"  {new string('-', 8)}  {new string('-', 6)}  {new string('-', 22)}  {new string('-', 18)}  {new string('-', 10)}  -----");
        var ordered = _buckets
            .OrderByDescending(kv => Interlocked.Read(ref kv.Value.Count))
            .ToList();
        foreach (var kv in ordered) {
            var (arch, cat, scale, src) = kv.Key;
            var b = kv.Value;
            string ids = string.Join(" ", b.SampleIds.Select(i => $"0x{i:X8}"));
            string names = (b.SampleNames is { Count: > 0 })
                ? "  [" + string.Join(", ", b.SampleNames.Take(8)) + "]"
                : "";
            sb.AppendLine($"  {b.Count,8:N0}  {src,6}  {Trunc(arch, 22),-22}  {Trunc(cat, 18),-18}  {Trunc(scale, 10),-10}  {ids}{names}");
        }
        return sb.ToString();
    }

    private static string Trunc(string s, int max) =>
        s.Length <= max ? s : s.Substring(0, Math.Max(0, max - 1)) + "…";
}
