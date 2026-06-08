using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// E1 (wave-2) PR2 — Option A (per-class) world-DB enrichment SQL generator.
    ///
    /// Consumes the set of <see cref="EnrichedPlacement"/> records (the
    /// <c>placements_enriched.jsonl</c> source of truth) and produces the per-table
    /// <c>weenie_properties_*</c> SQL via <see cref="AceDbConnector"/>'s per-class emitters,
    /// resolving the per-class (weenie-level) boundary:
    ///
    /// <list type="number">
    /// <item>Only placements with <see cref="EnrichmentScope.ClassDefault"/> are emitted here
    /// (PR2 scope). <see cref="EnrichmentScope.PlacementOverride"/> is PR3 (biota) and is
    /// COUNTED-and-SKIPPED, never silently misrouted to a weenie table.</item>
    /// <item>Enrichment is keyed by wcid. Multiple placements of one wcid that carry IDENTICAL
    /// enrichment collapse to a single weenie row set. If they carry CONFLICTING enrichment, PR2
    /// cannot pick one (wrapper-weenie minting is PR3+, SPEC §3.4 open question 2): the conflicting
    /// wcid is RECORDED in <see cref="EnrichmentSqlBundle.Conflicts"/> and SKIPPED for the
    /// conflicting table — HARD CONSTRAINT 4 (no silent pick).</item>
    /// </list>
    ///
    /// <para>Determinism (golden stability): wcids are processed in ascending numeric order; within
    /// generator the profile list order is preserved (it is meaningful), within positions the keys
    /// are ascending by <see cref="PositionType"/> ushort.</para>
    /// </summary>
    public static class EnrichmentSqlExporter {
        /// <summary>
        /// One generated per-table artifact: the table name, its full SQL text (DELETE+INSERT
        /// blocks, one block per emitted wcid, blank-line separated), and the wcid count.
        /// </summary>
        public sealed class EnrichmentSqlTable {
            public string Table { get; init; } = "";
            public string FileName { get; init; } = "";
            public string Sql { get; init; } = "";
            public int WeenieCount { get; init; }
        }

        /// <summary>The full set of generated per-class enrichment artifacts + diagnostics.</summary>
        public sealed class EnrichmentSqlBundle {
            public EnrichmentSqlTable? Palette { get; init; }
            public EnrichmentSqlTable? Generator { get; init; }
            public EnrichmentSqlTable? Position { get; init; }
            public EnrichmentSqlTable? Int { get; init; }
            public EnrichmentSqlTable? Float { get; init; }

            /// <summary>wcids skipped because two placements disagreed on enrichment (HARD CONSTRAINT 4).</summary>
            public IReadOnlyList<AceDbConnector.EnrichmentConflict> Conflicts { get; init; }
                = Array.Empty<AceDbConnector.EnrichmentConflict>();

            /// <summary>Count of placements skipped because their scope is PlacementOverride (PR3).</summary>
            public int PlacementOverrideSkipped { get; init; }

            public IEnumerable<EnrichmentSqlTable> Tables {
                get {
                    if (Palette != null) yield return Palette;
                    if (Generator != null) yield return Generator;
                    if (Position != null) yield return Position;
                    if (Int != null) yield return Int;
                    if (Float != null) yield return Float;
                }
            }

            /// <summary>True when any enrichment row was generated.</summary>
            public bool HasAny => Tables.Any();
        }

        // ── Per-wcid resolved enrichment (the weenie-level merge) ────────────

        private sealed class Resolved {
            public PlacementDye? Dye;
            public List<PlacementGenerator>? Generators;
            public Dictionary<PositionType, PlacementPosition>? Positions;
        }

        /// <summary>
        /// Build the per-class enrichment SQL bundle from the enriched placements.
        /// </summary>
        public static EnrichmentSqlBundle Build(IEnumerable<EnrichedPlacement> placements) {
            var conflicts = new List<AceDbConnector.EnrichmentConflict>();
            int overrideSkipped = 0;

            // Group by wcid, resolving the weenie-level enrichment. A wcid contributes to a table
            // only if ALL its ClassDefault placements agree (or only one carries that facet).
            var byWcid = new SortedDictionary<uint, Resolved>();
            var paletteConflict = new HashSet<uint>();
            var generatorConflict = new HashSet<uint>();
            var positionConflict = new HashSet<uint>();
            var intConflict = new HashSet<uint>();
            var floatConflict = new HashSet<uint>();

            foreach (var p in placements) {
                if (p.Scope == EnrichmentScope.PlacementOverride) {
                    // PR3 territory (biota override). Do NOT misroute to a weenie table.
                    if (HasEnrichment(p)) overrideSkipped++;
                    continue;
                }
                if (!HasEnrichment(p)) continue;

                if (!byWcid.TryGetValue(p.WeenieClassId, out var r)) {
                    r = new Resolved();
                    byWcid[p.WeenieClassId] = r;
                }
                MergeInto(p, r, conflicts,
                    paletteConflict, generatorConflict, positionConflict, intConflict, floatConflict);
            }

            // Emit each table, skipping any wcid flagged conflicting for THAT table.
            var paletteBlocks = new List<(uint, string)>();
            var generatorBlocks = new List<(uint, string)>();
            var positionBlocks = new List<(uint, string)>();
            var intBlocks = new List<(uint, string)>();
            var floatBlocks = new List<(uint, string)>();

            foreach (var (wcid, r) in byWcid) {
                if (r.Dye != null) {
                    if (!paletteConflict.Contains(wcid)) {
                        var s = AceDbConnector.GeneratePaletteSql(wcid, r.Dye);
                        if (s != null) paletteBlocks.Add((wcid, s));
                    }
                    if (!intConflict.Contains(wcid)) {
                        var s = AceDbConnector.GeneratePaletteTemplateIntSql(wcid, r.Dye);
                        if (s != null) intBlocks.Add((wcid, s));
                    }
                    if (!floatConflict.Contains(wcid)) {
                        var s = AceDbConnector.GenerateShadeFloatSql(wcid, r.Dye);
                        if (s != null) floatBlocks.Add((wcid, s));
                    }
                }
                if (r.Generators != null && r.Generators.Count > 0 && !generatorConflict.Contains(wcid)) {
                    var s = AceDbConnector.GenerateGeneratorSql(wcid, r.Generators);
                    if (s != null) generatorBlocks.Add((wcid, s));
                }
                if (r.Positions != null && r.Positions.Count > 0 && !positionConflict.Contains(wcid)) {
                    var s = AceDbConnector.GeneratePositionSql(wcid, r.Positions);
                    if (s != null) positionBlocks.Add((wcid, s));
                }
            }

            // Determinism (golden stability): the conflict list is appended in input order, which is
            // caller-dependent and NOT reproducible run-to-run. Sort it by (wcid, table) so the
            // manifest artifact is byte-stable regardless of how the placements were enumerated.
            var sortedConflicts = conflicts
                .OrderBy(c => c.WeenieClassId)
                .ThenBy(c => c.Table, StringComparer.Ordinal)
                .ToList();

            return new EnrichmentSqlBundle {
                Palette = Assemble("weenie_properties_palette", AceDbConnector.PaletteSqlFileName, paletteBlocks),
                Generator = Assemble("weenie_properties_generator", AceDbConnector.GeneratorSqlFileName, generatorBlocks),
                Position = Assemble("weenie_properties_position", AceDbConnector.PositionSqlFileName, positionBlocks),
                Int = Assemble("weenie_properties_int", AceDbConnector.IntSqlFileName, intBlocks),
                Float = Assemble("weenie_properties_float", AceDbConnector.FloatSqlFileName, floatBlocks),
                Conflicts = sortedConflicts,
                PlacementOverrideSkipped = overrideSkipped,
            };
        }

        /// <summary>
        /// Build the bundle and WRITE each non-empty table to <paramref name="outDir"/> as
        /// <c>weenie_properties_*.sql</c>, plus an <c>enrichment_manifest.json</c> describing what
        /// was written (and any conflicts/skips). NEVER touches a live DB — this is the dry-run /
        /// file-emit path (HARD CONSTRAINT: no live DB). Returns the bundle and written paths.
        /// </summary>
        public static (EnrichmentSqlBundle Bundle, List<string> WrittenPaths, string ManifestPath) WriteFiles(
            string outDir, IEnumerable<EnrichedPlacement> placements) {
            Directory.CreateDirectory(outDir);
            var bundle = Build(placements);

            var written = new List<string>();
            var enc = new UTF8Encoding(false);
            foreach (var t in bundle.Tables) {
                var path = Path.Combine(outDir, t.FileName);
                File.WriteAllText(path, t.Sql, enc);
                written.Add(path);
            }

            var manifestPath = Path.Combine(outDir, "enrichment_manifest.json");
            File.WriteAllText(manifestPath, BuildManifestJson(bundle, written), enc);

            return (bundle, written, manifestPath);
        }

        // ── Manifest (deterministic, no DB) ─────────────────────────────────

        private static string BuildManifestJson(EnrichmentSqlBundle bundle, List<string> writtenPaths) {
            var sb = new StringBuilder();
            sb.Append('{');
            sb.Append("\"scope\":\"ClassDefault\",");
            sb.Append("\"tables\":[");
            bool first = true;
            foreach (var t in bundle.Tables) {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('{')
                  .Append("\"table\":\"").Append(Esc(t.Table)).Append("\",")
                  .Append("\"file\":\"").Append(Esc(t.FileName)).Append("\",")
                  .Append("\"weenieCount\":").Append(t.WeenieCount.ToString(CultureInfo.InvariantCulture))
                  .Append('}');
            }
            sb.Append("],");
            sb.Append("\"conflicts\":[");
            for (int i = 0; i < bundle.Conflicts.Count; i++) {
                if (i > 0) sb.Append(',');
                var c = bundle.Conflicts[i];
                sb.Append('{')
                  .Append("\"wcid\":").Append(c.WeenieClassId.ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"table\":\"").Append(Esc(c.Table)).Append("\",")
                  .Append("\"detail\":\"").Append(Esc(c.Detail)).Append("\"")
                  .Append('}');
            }
            sb.Append("],");
            sb.Append("\"placementOverrideSkipped\":")
              .Append(bundle.PlacementOverrideSkipped.ToString(CultureInfo.InvariantCulture));
            sb.Append('}');
            return sb.ToString();
        }

        private static string Esc(string s) =>
            s.Replace("\\", "\\\\").Replace("\"", "\\\"");

        // ── Internals ───────────────────────────────────────────────────────

        private static bool HasEnrichment(EnrichedPlacement p) =>
            (p.Dye != null && (p.Dye.SubPaletteId.HasValue || p.Dye.PaletteTemplate.HasValue || p.Dye.Shade.HasValue))
            || (p.Generators != null && p.Generators.Count > 0)
            || (p.Positions != null && p.Positions.Count > 0);

        /// <summary>
        /// Merge one placement's enrichment into the resolved per-wcid record. First writer wins as
        /// the canonical tuple; a later DIFFERING value for the same facet flags a conflict for that
        /// table (HARD CONSTRAINT 4) — the wcid is then skipped for that table only.
        /// </summary>
        private static void MergeInto(
            EnrichedPlacement p, Resolved r,
            List<AceDbConnector.EnrichmentConflict> conflicts,
            HashSet<uint> paletteConflict, HashSet<uint> generatorConflict,
            HashSet<uint> positionConflict, HashSet<uint> intConflict, HashSet<uint> floatConflict) {

            uint wcid = p.WeenieClassId;

            // ── Palette (SubPaletteId + Offset + Length) ──
            if (p.Dye != null && p.Dye.SubPaletteId.HasValue) {
                if (r.Dye == null || !r.Dye.SubPaletteId.HasValue) {
                    r.Dye ??= new PlacementDye();
                    r.Dye.SubPaletteId = p.Dye.SubPaletteId;
                    r.Dye.Offset = p.Dye.Offset;
                    r.Dye.Length = p.Dye.Length;
                }
                else if (r.Dye.SubPaletteId != p.Dye.SubPaletteId
                         || r.Dye.Offset != p.Dye.Offset
                         || r.Dye.Length != p.Dye.Length) {
                    FlagConflict(conflicts, paletteConflict, wcid, "weenie_properties_palette",
                        $"wcid 0x{wcid:X8} has conflicting SubPalette dye across placements");
                }
            }

            // ── Int / PaletteTemplate (type=3) ──
            if (p.Dye != null && p.Dye.PaletteTemplate.HasValue) {
                if (r.Dye == null || !r.Dye.PaletteTemplate.HasValue) {
                    r.Dye ??= new PlacementDye();
                    r.Dye.PaletteTemplate = p.Dye.PaletteTemplate;
                }
                else if (r.Dye.PaletteTemplate != p.Dye.PaletteTemplate) {
                    FlagConflict(conflicts, intConflict, wcid, "weenie_properties_int",
                        $"wcid 0x{wcid:X8} has conflicting PaletteTemplate (type=3) across placements");
                }
            }

            // ── Float / Shade (type=12) ──
            if (p.Dye != null && p.Dye.Shade.HasValue) {
                if (r.Dye == null || !r.Dye.Shade.HasValue) {
                    r.Dye ??= new PlacementDye();
                    r.Dye.Shade = p.Dye.Shade;
                }
                else if (r.Dye.Shade != p.Dye.Shade) {
                    FlagConflict(conflicts, floatConflict, wcid, "weenie_properties_float",
                        $"wcid 0x{wcid:X8} has conflicting Shade (type=12) across placements");
                }
            }

            // ── Generators (whole-list equality) ──
            if (p.Generators != null && p.Generators.Count > 0) {
                if (r.Generators == null) {
                    r.Generators = p.Generators.ToList();
                }
                else if (!GeneratorsEqual(r.Generators, p.Generators)) {
                    FlagConflict(conflicts, generatorConflict, wcid, "weenie_properties_generator",
                        $"wcid 0x{wcid:X8} has conflicting generator profiles across placements");
                }
            }

            // ── Positions (whole-map equality) ──
            if (p.Positions != null && p.Positions.Count > 0) {
                if (r.Positions == null) {
                    r.Positions = new Dictionary<PositionType, PlacementPosition>(p.Positions);
                }
                else if (!PositionsEqual(r.Positions, p.Positions)) {
                    FlagConflict(conflicts, positionConflict, wcid, "weenie_properties_position",
                        $"wcid 0x{wcid:X8} has conflicting position map across placements");
                }
            }
        }

        private static void FlagConflict(
            List<AceDbConnector.EnrichmentConflict> conflicts, HashSet<uint> set,
            uint wcid, string table, string detail) {
            if (set.Add(wcid))
                conflicts.Add(new AceDbConnector.EnrichmentConflict { WeenieClassId = wcid, Table = table, Detail = detail });
        }

        private static bool GeneratorsEqual(List<PlacementGenerator> a, List<PlacementGenerator> b) {
            if (a.Count != b.Count) return false;
            for (int i = 0; i < a.Count; i++)
                if (!GeneratorEqual(a[i], b[i])) return false;
            return true;
        }

        private static bool GeneratorEqual(PlacementGenerator a, PlacementGenerator b) =>
            a.Probability.Equals(b.Probability)
            && a.WeenieClassId == b.WeenieClassId
            && NullableFloatEqual(a.Delay, b.Delay)
            && a.InitCreate == b.InitCreate
            && a.MaxCreate == b.MaxCreate
            && a.WhenCreate == b.WhenCreate
            && a.WhereCreate == b.WhereCreate
            && a.StackSize == b.StackSize
            && a.PaletteTemplate == b.PaletteTemplate
            && NullableFloatEqual(a.Shade, b.Shade)
            && a.ObjCellId == b.ObjCellId
            && NullableFloatEqual(a.OriginX, b.OriginX)
            && NullableFloatEqual(a.OriginY, b.OriginY)
            && NullableFloatEqual(a.OriginZ, b.OriginZ)
            && NullableFloatEqual(a.AnglesW, b.AnglesW)
            && NullableFloatEqual(a.AnglesX, b.AnglesX)
            && NullableFloatEqual(a.AnglesY, b.AnglesY)
            && NullableFloatEqual(a.AnglesZ, b.AnglesZ);

        private static bool PositionsEqual(
            Dictionary<PositionType, PlacementPosition> a,
            IReadOnlyDictionary<PositionType, PlacementPosition> b) {
            if (a.Count != b.Count) return false;
            foreach (var kv in a) {
                if (!b.TryGetValue(kv.Key, out var bv)) return false;
                if (!PositionEqual(kv.Value, bv)) return false;
            }
            return true;
        }

        private static bool PositionEqual(PlacementPosition a, PlacementPosition b) =>
            a.ObjCellId == b.ObjCellId
            && a.OriginX.Equals(b.OriginX) && a.OriginY.Equals(b.OriginY) && a.OriginZ.Equals(b.OriginZ)
            && a.AnglesW.Equals(b.AnglesW) && a.AnglesX.Equals(b.AnglesX)
            && a.AnglesY.Equals(b.AnglesY) && a.AnglesZ.Equals(b.AnglesZ);

        private static bool NullableFloatEqual(float? a, float? b) {
            if (a.HasValue != b.HasValue) return false;
            if (!a.HasValue) return true; // both null
            return a.Value.Equals(b!.Value);
        }

        /// <summary>
        /// Concatenate per-wcid DELETE+INSERT blocks (ascending wcid) into one table file, with a
        /// stable header comment and blank-line separators. Returns null when there are no blocks.
        /// </summary>
        private static EnrichmentSqlTable? Assemble(string table, string fileName, List<(uint Wcid, string Sql)> blocks) {
            if (blocks.Count == 0) return null;
            var sb = new StringBuilder();
            sb.Append("-- ACME WorldBuilder E1: ").Append(table).Append(" (per-class enrichment, Option A)").Append('\n');
            sb.Append("-- ").Append(blocks.Count.ToString(CultureInfo.InvariantCulture)).Append(" weenie(s)").Append('\n');
            sb.Append('\n');
            for (int i = 0; i < blocks.Count; i++) {
                sb.Append(blocks[i].Sql);
                sb.Append('\n');
            }
            return new EnrichmentSqlTable {
                Table = table,
                FileName = fileName,
                Sql = sb.ToString(),
                WeenieCount = blocks.Count,
            };
        }
    }
}
