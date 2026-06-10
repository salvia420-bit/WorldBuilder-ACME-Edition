using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace WorldBuilder.Terminal;

/// <summary>
/// Melt-integration follow-on (2026-06-10) — informational resource.
///
/// <c>melt-reference [topic]</c> serves the agent briefing for the melt
/// functionality that was deliberately DEFERRED (not implemented) by the
/// integration plan: pre-ToD/Dark-Majesty texture codecs, DM↔ToD ID
/// migration tables, PhatAC cache converters, and ACE-DB content-mutation
/// recipes. Content lives in <c>docs/melt-deferred-reference.md</c> (the
/// command parses its stable <c>## N. Title</c> section anchors at call
/// time, so editing the doc updates the command output with no rebuild).
///
/// Without a topic: lists topics + summaries + the doc path. With a topic
/// (<c>dm-textures</c> | <c>id-migration</c> | <c>cache-converters</c> |
/// <c>acedb-recipes</c>): returns that section's full markdown, including
/// melt file:line pointers.
///
/// This is a READ-ONLY knowledge surface — none of the described melt
/// functionality is implemented, and melt code must never be linked
/// (external/melt/VENDORED.md licensing).
/// </summary>
public partial class CommandEngine {

    private static readonly (string Key, string Heading, string Summary)[] MeltReferenceTopics = {
        ("dm-textures", "## 1. Dark Majesty / pre-ToD texture codecs",
            "DM-era 0x04/0x10/0x11 planar texture containers vs ToD 0x06, per-era pixel format codes, the 41-entry DM→ToD landscape/detail ID table, toBin write sequences."),
        ("id-migration", "## 2. DM↔ToD ID migration tables",
            "Melt's positional cross-era texture/object ID pairing (buildTextureIdMigrationTable / buildObjectIdMigrationTable) and Surface fingerprint matching; notes the modern same-era equivalent (surface-fingerprint command)."),
        ("cache-converters", "## 3. Cache converters (cache4/6/8/9)",
            "PhatAC server cache dump (000N.raw) formats: item interactions, landblock spawns+links, quest flags, and the full weenie table — binary↔JSON round-trip shapes. Archaeology only (PhatAC deprecated)."),
        ("acedb-recipes", "## 4. ACE-DB content-mutation recipes",
            "Catalog of melt's ~50 live-MySQL vendor/item/XP/loot rebalancing recipes plus the 8-tier loot mutation-script generator. Pattern reference for ACE-DB economy work."),
    };

    /// <summary>Walk up from the binary directory to find docs/melt-deferred-reference.md
    /// (same convention as DefaultChoriziteSourceRoot).</summary>
    private static string ResolveMeltReferenceDocPath() {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null) {
            var candidate = Path.Combine(dir.FullName, "docs", "melt-deferred-reference.md");
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        var fallback = "/home/wbterminal/WorldBuilder-ACME-Edition/docs/melt-deferred-reference.md";
        if (File.Exists(fallback)) return fallback;
        throw new FileNotFoundException(
            "docs/melt-deferred-reference.md not found walking up from the binary directory.");
    }

    public MeltReferenceResult MeltReference(string? topic) {
        var docPath = ResolveMeltReferenceDocPath();

        if (string.IsNullOrWhiteSpace(topic)) {
            return new MeltReferenceResult(
                Topic: null,
                DocPath: docPath,
                Topics: MeltReferenceTopics
                    .Select(t => new MeltReferenceTopicRow(t.Key, t.Heading.TrimStart('#', ' '), t.Summary))
                    .ToList(),
                Markdown: null,
                Note: "Informational resource only — describes DEFERRED melt functionality (not implemented). " +
                      "Pass topic to get a full section. Melt source is research-reference-only; never link/copy it.");
        }

        var key = topic.Trim().ToLowerInvariant();
        var match = MeltReferenceTopics.FirstOrDefault(t => t.Key == key);
        if (match.Key == null)
            throw new ArgumentException(
                $"Unknown topic '{topic}'. Valid: {string.Join(", ", MeltReferenceTopics.Select(t => t.Key))}.");

        var lines = File.ReadAllLines(docPath);
        var sb = new StringBuilder();
        bool inSection = false;
        foreach (var line in lines) {
            if (line.StartsWith("## ", StringComparison.Ordinal)) {
                if (inSection) break;
                if (line.TrimEnd().Equals(match.Heading, StringComparison.Ordinal)) inSection = true;
            }
            if (inSection) sb.AppendLine(line);
        }
        if (sb.Length == 0)
            throw new InvalidOperationException(
                $"Section anchor '{match.Heading}' not found in {docPath} — the doc's section headers must stay stable.");

        return new MeltReferenceResult(
            Topic: match.Key,
            DocPath: docPath,
            Topics: null,
            Markdown: sb.ToString().TrimEnd(),
            Note: "Deferred-functionality briefing (melt is behavioral reference only). " +
                  "Full plan + licensing rules: docs/melt-integration-plan-2026-06-10.md.");
    }
}

// ── Melt-reference results ───────────────────────────────────────────
public record MeltReferenceTopicRow(string Key, string Title, string Summary);

public record MeltReferenceResult(
    string? Topic,
    string DocPath,
    List<MeltReferenceTopicRow>? Topics,
    string? Markdown,
    string Note);
