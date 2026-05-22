using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave-1 UI port — extract the retail-AC <c>SkillTable</c> from
/// <c>client_portal.dat</c> as a JSON dump so the holtburger-web Skills view
/// (PR-V of the main panel) can render each skill row with its retail icon
/// without having to re-implement the DRW parser in JS.
///
/// One command:
///
///   - <c>chorizite-dump-skill-table</c> — open the portal DAT (default
///     <c>~/ac_base_dats/client_portal.dat</c> per
///     [[feedback_base_dats_only_for_bake]]) via <see cref="DRW.DatDatabase"/>
///     just like <c>DatReaderWriter.Tests.DBObjs.SkillTableTests</c>'s
///     <c>CanReadEORSkillTable</c> test does, call
///     <c>dat.TryGet&lt;SkillTable&gt;(0xE000004u, out var skillTable)</c>,
///     then walk the <c>Skills</c> dictionary
///     <see cref="DRW.Enums.SkillId"/> → <see cref="DRW.Types.SkillBase"/>
///     and emit one JSON record per skill. The icon-DID (a
///     <see cref="DRW.Types.QualifiedDataId{T}"/> with <c>T = RenderSurface</c>)
///     is surfaced both as a hex string (e.g. <c>"0x06000165"</c>) and a
///     decimal uint so the JS side can route it through the existing
///     <c>chorizite-extract-ui-textures</c> pipeline if a sprite isn't
///     already baked.
///
/// The dump intentionally matches the test's EOR-validated values:
/// <c>MeleeDefense.IconId == 0x06000165</c>,
/// <c>Summoning.IconId == 0x0600740C</c>, and
/// <c>SkillTable.Skills.Count == 38</c>. Spot-check those after a build.
///
/// We default the output to inline (no file write); if the caller passes
/// <c>outPath</c>, the same JSON envelope is also written to disk so it
/// can be checked into the holtburger-web tree as
/// <c>apps/holtburger-web/data/skill-table.json</c>.
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  Result records
    // ─────────────────────────────────────────────────────────────────

    public sealed record SkillTableDumpResult(
        string SkillTableIdHex,
        uint SkillTableId,
        string DatPath,
        string? OutPath,
        int SkillCount,
        IReadOnlyList<SkillTableDumpRecord> Skills,
        SkillTableDumpSummary Summary);

    public sealed record SkillTableDumpRecord(
        string SkillId,         // hex form, e.g. "0x0006"
        int SkillIdInt,
        string SkillIdName,     // enum name, e.g. "MeleeDefense"
        string Name,            // display name, e.g. "Melee Defense"
        string Description,
        string Category,        // enum name, e.g. "Combat"
        int CategoryInt,
        bool ChargenUse,
        string IconIdHex,       // e.g. "0x06000165"
        uint IconIdInt,
        double LearnMod,
        int LowerBound,
        int UpperBound,
        uint MinLevel,
        int SpecializedCost,
        int TrainedCost,
        SkillTableFormulaRecord Formula);

    public sealed record SkillTableFormulaRecord(
        string Attribute1,
        int Attribute1Int,
        string Attribute2,
        int Attribute2Int,
        int Attribute1Multiplier,
        int Attribute2Multiplier,
        int Divisor,
        int AdditiveBonus);

    public sealed record SkillTableDumpSummary(
        int SkillCount,
        IReadOnlyList<string> UniqueIconIds,
        IReadOnlyList<SkillTableCategoryCount> Categories);

    public sealed record SkillTableCategoryCount(string Category, int CategoryInt, int Count);

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-dump-skill-table
    // ─────────────────────────────────────────────────────────────────

    public SkillTableDumpResult ChoriziteDumpSkillTable(uint skillTableId, string? outPath, string? datPath) {
        // Resolve datPath. We reuse the alias resolver from the
        // CommandEngine.UiSpriteExtract partial (ResolveDatPathOrAlias),
        // defaulting to the portal DAT — SkillTable lives at 0xE000004
        // on the portal-side DAT (per dats.xml SkillTable stanza
        // `first="0xE000004" last="0xE000004"`).
        var resolvedPortal = ResolveDatPathOrAlias(datPath, defaultAlias: "portal");

        // Mirror the DRW test (CanReadEORSkillTable in
        // DatReaderWriter.Tests/DBObjs/SkillTableTests.cs) — open a bare
        // DatDatabase against the portal DAT, no DatCollection needed
        // since SkillBase's only DID field (IconId) is a value-type
        // QualifiedDataId<RenderSurface> whose Unpack doesn't reach
        // back through the collection. Keeping the lifetime narrow
        // means we don't trip the highres-dat fallback the UI-sprite
        // command has to deal with.
        using var dat = new DRW.DatDatabase(options => {
            options.FilePath = resolvedPortal;
            options.AccessType = DRW.Options.DatAccessType.Read;
            // Caching strategy mirrors EOR test: Never. We're a
            // one-shot dump; no need to keep an index cache around.
            options.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
        });

        if (!dat.TryGet<DRW.DBObjs.SkillTable>(skillTableId, out var skillTable) || skillTable == null) {
            throw new InvalidOperationException(
                $"SkillTable 0x{skillTableId:X8} not found in {resolvedPortal}.");
        }

        // Walk the (SkillId → SkillBase) dictionary in stable SkillId
        // order so the JSON output is reproducible run-to-run.
        var records = new List<SkillTableDumpRecord>(skillTable.Skills.Count);
        foreach (var kvp in skillTable.Skills.OrderBy(p => (int)p.Key)) {
            records.Add(BuildSkillRecord(kvp.Key, kvp.Value));
        }

        // Build summary: unique icon DIDs (sorted) + category histogram.
        var uniqueIcons = records.Select(r => r.IconIdInt)
            .Where(d => d != 0)
            .Distinct()
            .OrderBy(d => d)
            .Select(d => $"0x{d:X8}")
            .ToList();
        var categoryGroups = records.GroupBy(r => (r.Category, r.CategoryInt))
            .OrderBy(g => g.Key.CategoryInt)
            .Select(g => new SkillTableCategoryCount(g.Key.Category, g.Key.CategoryInt, g.Count()))
            .ToList();

        var summary = new SkillTableDumpSummary(
            SkillCount: records.Count,
            UniqueIconIds: uniqueIcons,
            Categories: categoryGroups);

        var result = new SkillTableDumpResult(
            SkillTableIdHex: $"0x{skillTableId:X8}",
            SkillTableId: skillTableId,
            DatPath: resolvedPortal,
            OutPath: outPath,
            SkillCount: records.Count,
            Skills: records,
            Summary: summary);

        // Write out to disk if requested. We re-emit the same envelope
        // JsonCommandProcessor will produce, so the on-disk file and the
        // stdin response carry identical shapes.
        if (!string.IsNullOrWhiteSpace(outPath)) {
            var outDir = Path.GetDirectoryName(outPath);
            if (!string.IsNullOrEmpty(outDir) && !Directory.Exists(outDir)) {
                Directory.CreateDirectory(outDir);
            }
            var jsonBody = new {
                success = true,
                command = "chorizite-dump-skill-table",
                skillTableIdHex = result.SkillTableIdHex,
                datPath = result.DatPath,
                outPath = result.OutPath,
                skillCount = result.SkillCount,
                skills = result.Skills,
                summary = result.Summary,
            };
            File.WriteAllText(outPath,
                JsonSerializer.Serialize(jsonBody, new JsonSerializerOptions {
                    WriteIndented = true,
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                    Encoder = System.Text.Encodings.Web.JavaScriptEncoder
                        .UnsafeRelaxedJsonEscaping,
                }));
        }
        return result;
    }

    /// <summary>
    /// Build one <see cref="SkillTableDumpRecord"/> from a
    /// <see cref="DRW.Enums.SkillId"/> / <see cref="DRW.Types.SkillBase"/>
    /// pair. Reflects defensively on the AC1Legacy PStringBase wrapper
    /// (its <c>Value</c> property is a plain <see cref="string"/>) and the
    /// <see cref="DRW.Types.QualifiedDataId{T}"/> wrapper around
    /// <c>IconId</c> (its <c>DataId</c> property is the bare uint we want).
    /// </summary>
    private static SkillTableDumpRecord BuildSkillRecord(DRW.Enums.SkillId skillId, DRW.Types.SkillBase skill) {
        var skillIdInt = (int)skillId;

        // Name + Description live behind AC1LegacyPStringBase<byte>'s
        // .Value property. Use reflection rather than a direct
        // generic-typed call so this code remains forward-compatible
        // if DRW ever swaps the inner generic argument.
        string name = ExtractSkillPStringValue(skill.Name) ?? string.Empty;
        string description = ExtractSkillPStringValue(skill.Description) ?? string.Empty;

        // IconId is QualifiedDataId<RenderSurface> — reflect over the
        // DataId property to pull the underlying uint without taking a
        // type dep on the closed generic.
        uint iconIdInt = ExtractSkillQualifiedDataId(skill.IconId);

        var categoryInt = (int)skill.Category;

        var formulaRec = new SkillTableFormulaRecord(
            Attribute1: skill.Formula.Attribute1.ToString(),
            Attribute1Int: (int)skill.Formula.Attribute1,
            Attribute2: skill.Formula.Attribute2.ToString(),
            Attribute2Int: (int)skill.Formula.Attribute2,
            Attribute1Multiplier: skill.Formula.Attribute1Multiplier,
            Attribute2Multiplier: skill.Formula.Attribute2Multiplier,
            Divisor: skill.Formula.Divisor,
            AdditiveBonus: skill.Formula.AdditiveBonus);

        return new SkillTableDumpRecord(
            // SkillId hex padded to 4 hex digits (the enum tops out at
            // 54 = 0x36, but we pad to 4 for symmetry with other
            // 16-bit IDs and stable column width in dumps).
            SkillId: $"0x{skillIdInt:X4}",
            SkillIdInt: skillIdInt,
            SkillIdName: skillId.ToString(),
            Name: name,
            Description: description,
            Category: skill.Category.ToString(),
            CategoryInt: categoryInt,
            ChargenUse: skill.ChargenUse,
            IconIdHex: $"0x{iconIdInt:X8}",
            IconIdInt: iconIdInt,
            // LearnMod / UpperBound / LowerBound are doubles on the
            // wire; the test casts to float for comparison but we
            // surface the double so JS gets the full precision.
            LearnMod: skill.LearnMod,
            // LowerBound/UpperBound are double in DRW but int in the
            // ACBindings struct and the EOR test (120, 900). Both
            // round trip cleanly; truncate to int for the JSON record
            // shape the caller specced.
            LowerBound: (int)skill.LowerBound,
            UpperBound: (int)skill.UpperBound,
            MinLevel: skill.MinLevel,
            SpecializedCost: skill.SpecializedCost,
            TrainedCost: skill.TrainedCost,
            Formula: formulaRec);
    }

    /// <summary>
    /// Reach through an <c>AC1LegacyPStringBase&lt;byte&gt;</c> (or
    /// any PStringBase variant) to read its inner <see cref="string"/>
    /// payload via the <c>Value</c> property. Returns <c>null</c> when
    /// the wrapper itself is null or the property is missing — both
    /// surface as an empty string in the dump.
    /// </summary>
    private static string? ExtractSkillPStringValue(object? wrapper) {
        if (wrapper == null) return null;
        var prop = wrapper.GetType().GetProperty("Value", BindingFlags.Public | BindingFlags.Instance);
        if (prop == null) return wrapper.ToString();
        return prop.GetValue(wrapper) as string;
    }

    /// <summary>
    /// Reach through a <see cref="DRW.Types.QualifiedDataId{T}"/> (or
    /// the non-generic base) to read its <c>DataId</c> property as a
    /// plain <see cref="uint"/>. Returns 0 when the wrapper is null
    /// or the property is missing — 0 isn't a valid retail DataID so
    /// the JS side can use it as a sentinel.
    /// </summary>
    private static uint ExtractSkillQualifiedDataId(object? wrapper) {
        if (wrapper == null) return 0;
        var prop = wrapper.GetType().GetProperty("DataId", BindingFlags.Public | BindingFlags.Instance);
        if (prop == null) return 0;
        var v = prop.GetValue(wrapper);
        return v switch {
            uint u => u,
            int i when i >= 0 => (uint)i,
            _ => 0,
        };
    }
}
