using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// E1 (wave-2) PR2 — per-CLASS (Option A / <see cref="EnrichmentScope.ClassDefault"/>) SQL
    /// emitters that GENERATE ACE world-DB enrichment SQL from the <see cref="EnrichedPlacement"/>
    /// data (the <c>placements_enriched.jsonl</c> source of truth, SPEC §4).
    ///
    /// <para>Three per-table emitters, one ACE table each:</para>
    /// <list type="bullet">
    /// <item><b>dye</b> → <c>weenie_properties_palette</c> (SubPaletteId 0x04 DID + Offset + Length)
    /// plus, for the optional template tint, <c>weenie_properties_int</c> (type=3 PaletteTemplate)
    /// and <c>weenie_properties_float</c> (type=12 Shade);</item>
    /// <item><b>generator</b> → <c>weenie_properties_generator</c> (the exact named column list of
    /// <c>WeenieSQLWriter.cs:751-753</c>), one row per profile;</item>
    /// <item><b>positions</b> → <c>weenie_properties_position</c>, one row per
    /// <see cref="PositionType"/> key.</item>
    /// </list>
    ///
    /// <para>FORMAT FIDELITY (HARD CONSTRAINT 2): output is SEMANTICALLY EQUIVALENT to ACE's
    /// <c>ACE.Database/SQLFormatters/WeenieSQLWriter</c> with the SAME value-bearing tokens — same
    /// table/column names and order, the <c>INSERT … (cols)</c> header + <c>VALUES (…)</c> /
    /// <c>     , (…)</c> value lines ending in <c>;</c>, the same numeric formatting (<c>0.######</c>
    /// with negative-zero trimmed, plain decimal for <c>sub_Palette_Id</c> /
    /// <c>palette_Id</c> / <c>when_Create</c> / <c>where_Create</c>, hex <c>0x%08X</c> for
    /// <c>obj_Cell_Id</c> when &gt; 0), and null → <c>NULL</c> via the same FixNullFields rule.
    /// It is NOT a byte-for-byte clone of an ACE dump: ACE's optional friendly
    /// <c>/* Generate … */</c> / <c>/* PositionName */</c> / <c>@teleloc</c> cribs and its
    /// <c>PadLeft</c> column alignment are NOT reproduced (both are MySQL-insignificant), and a hex
    /// crib comment is appended to the palette row for human readers. The re-importable data is
    /// identical to what ACE would read back.</para>
    ///
    /// <para>IDEMPOTENCY: ACE's canonical export wipes-then-writes (a weenie-level DELETE that
    /// FK-cascades to every property table). Per-table here, that is a
    /// <c>DELETE FROM `table` WHERE `object_Id` = wcid;</c> emitted before the INSERT for that wcid,
    /// so re-running the script is a no-op replace — mirroring ACE's DELETE+INSERT.</para>
    ///
    /// <para>SQL-INJECTION SAFETY: every emitted value is a numeric literal (uint/int/ushort/float)
    /// formatted under <see cref="CultureInfo.InvariantCulture"/>; no string interpolation of
    /// user/DB text reaches the SQL, so there is no injection surface. (The only string-bearing ACE
    /// property tables — string/book — are out of scope for E1 enrichment.)</para>
    ///
    /// <para>ADDRESSABILITY (HARD CONSTRAINT 3): <c>sub_Palette_Id</c> is the 0x04 Palette DID (NOT
    /// the generator PaletteTemplate enum); positions are keyed by the <see cref="PositionType"/>
    /// ushort written straight to <c>position_Type</c>; generator named fields map 1:1 to columns.</para>
    ///
    /// <para>This file is purely ADDITIVE — it touches none of the existing <c>landblock_instance</c>
    /// emitters in <c>AceDbConnector.cs</c> nor PR1's JSONL behavior (HARD CONSTRAINT 1).</para>
    /// </summary>
    public partial class AceDbConnector {
        /// <summary>The default ACE world database name used to scope nothing (these tables are
        /// referenced unqualified, matching <c>WeenieSQLWriter</c> which emits bare table names).</summary>
        public const string WorldDbName = "ace_world";

        // ── Per-class enrichment file names (one ACE table each) ─────────────
        public const string PaletteSqlFileName = "weenie_properties_palette.sql";
        public const string GeneratorSqlFileName = "weenie_properties_generator.sql";
        public const string PositionSqlFileName = "weenie_properties_position.sql";
        public const string IntSqlFileName = "weenie_properties_int.sql";
        public const string FloatSqlFileName = "weenie_properties_float.sql";

        /// <summary><c>PropertyInt.PaletteTemplate</c> — the template tint int property type.</summary>
        public const int PropertyInt_PaletteTemplate = 3;
        /// <summary><c>PropertyFloat.Shade</c> — the template shade float property type.</summary>
        public const int PropertyFloat_Shade = 12;

        // ── Number formatting (mirrors WeenieSQLWriter / SQLWriter) ──────────

        /// <summary>
        /// ACE's <c>TrimNegativeZero</c> + <c>0.######</c> formatting (SQLWriter.cs:450-463 /
        /// WeenieSQLWriter float interpolation). Renders a float with up to 6 fractional digits and
        /// strips a leading sign from a value that rounds to "-0", so "-0" never appears in output.
        /// </summary>
        internal static string FmtFloat6(float value) {
            // PR1's EnrichedPlacementStore.JsonOptions sets AllowNamedFloatingPointLiterals, so a
            // degenerate quaternion/vector can legitimately round-trip NaN/±Infinity through the
            // JSONL and reach here. ".ToString("0.######")" would render those as NaN/Infinity —
            // tokens that are NOT valid numeric SQL literals and are not caught by FixNullFields.
            // Collapse any non-finite value to 0 so the emitted SQL stays a valid numeric literal.
            if (!float.IsFinite(value)) return "0";
            string s = value.ToString("0.######", CultureInfo.InvariantCulture);
            if (s == "-0") s = "0";
            return s;
        }

        /// <summary>Nullable float → trimmed literal, or the sentinel that FixNullFields turns into NULL.</summary>
        private static string FmtFloat6OrNull(float? value) =>
            value.HasValue ? FmtFloat6(value.Value) : NullSentinel;

        /// <summary>
        /// ACE float-property format <c>0.###</c> (WeenieSQLWriter.cs:263) used for the Shade
        /// (type=12) value, with the same non-finite guard as <see cref="FmtFloat6"/> (NaN/±Infinity
        /// → 0) so the emitted literal is always valid numeric SQL.
        /// </summary>
        private static string FmtFloat3(float value) {
            if (!float.IsFinite(value)) return "0";
            return value.ToString("0.###", CultureInfo.InvariantCulture);
        }

        /// <summary>Nullable int → decimal literal, or the FixNullFields sentinel.</summary>
        private static string FmtIntOrNull(int? value) =>
            value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : NullSentinel;

        /// <summary>Nullable uint → decimal literal, or the FixNullFields sentinel.</summary>
        private static string FmtUIntOrNull(uint? value) =>
            value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : NullSentinel;

        /// <summary>
        /// Marker placed where ACE would emit nothing (an empty interpolation that
        /// <c>FixNullFields</c> later rewrites to <c>NULL</c>). We render the literal token directly
        /// for clarity/round-trip; semantically identical to ACE's ", ," → ", NULL," pass.
        /// </summary>
        private const string NullSentinel = "NULL";

        // ── Conflict resolution (HARD CONSTRAINT 4) ─────────────────────────

        /// <summary>
        /// Raised when two placements of the SAME wcid carry DIFFERENT enrichment under the
        /// per-class (Option A) scope. PR2 is weenie-level only: a wcid maps to exactly one
        /// enrichment tuple, so a divergence cannot be silently resolved (wrapper-weenie minting is
        /// PR3+ / SPEC §3.4 open question 2). The caller surfaces this and SKIPS the conflicting
        /// wcid rather than arbitrarily picking one.
        /// </summary>
        public sealed class EnrichmentConflict {
            public uint WeenieClassId { get; init; }
            public string Table { get; init; } = "";
            public string Detail { get; init; } = "";
        }

        // ── Public per-table emitters (one wcid's rows) ─────────────────────

        /// <summary>
        /// Emit the <c>weenie_properties_palette</c> DELETE+INSERT for one wcid's dye SubPalette
        /// remap. Returns null when the dye carries no addressable SubPaletteId (template-only dye
        /// has no palette row).
        ///
        /// <para><c>sub_Palette_Id</c> is written as PLAIN DECIMAL to match ACE's canonical
        /// <c>WeenieSQLWriter.cs:797</c> (<c>$"…, {input[i].SubPaletteId}, …"</c>) — ACE never
        /// hex-formats this column (contrast <c>obj_Cell_Id</c>, which it explicitly hex-formats).
        /// HARD CONSTRAINT 2 (byte-match ACE) overrides the SPEC PR2 note that mistakenly cited hex.
        /// Addressability (HARD CONSTRAINT 3) is preserved by the in-memory uint VALUE — the decimal
        /// IS the 0x04 DID — so we append the hex form as an inline crib comment for human readers
        /// only (MySQL-insignificant, mirroring ACE's other <c>/* … */</c> cribs).</para>
        /// </summary>
        public static string? GeneratePaletteSql(uint weenieClassId, PlacementDye dye) {
            if (dye is null || !dye.SubPaletteId.HasValue) return null;

            var sb = new StringBuilder();
            AppendDelete(sb, "weenie_properties_palette", weenieClassId);
            sb.AppendLine("INSERT INTO `weenie_properties_palette` (`object_Id`, `sub_Palette_Id`, `offset`, `length`)");
            var rows = new List<string> {
                $"{weenieClassId}, {dye.SubPaletteId.Value}, {dye.Offset}, {dye.Length})" +
                $" /* sub_Palette_Id 0x{dye.SubPaletteId.Value:X8} */",
            };
            AppendValues(sb, rows);
            return sb.ToString();
        }

        /// <summary>
        /// Emit the <c>weenie_properties_generator</c> DELETE+INSERT for one wcid's generator
        /// profiles (one VALUES row each). Column order is exactly WeenieSQLWriter.cs:751-753.
        /// Returns null when there are no profiles.
        ///
        /// <para>The generator's <c>palette_Id</c> = the template index (decimal, NOT a DID — SPEC
        /// §3.1) sourced from <see cref="PlacementGenerator.PaletteTemplate"/>, CLAMPED to ACE's
        /// <c>uint?</c> domain (≥ 0; a negative becomes 0 — SPEC PR2 / Finding 9).</para>
        /// </summary>
        public static string? GenerateGeneratorSql(uint weenieClassId, IReadOnlyList<PlacementGenerator>? generators) {
            if (generators is null || generators.Count == 0) return null;

            var sb = new StringBuilder();
            AppendDelete(sb, "weenie_properties_generator", weenieClassId);
            sb.AppendLine("INSERT INTO `weenie_properties_generator` (`object_Id`, `probability`, `weenie_Class_Id`, " +
                          "`delay`, `init_Create`, `max_Create`, `when_Create`, `where_Create`, `stack_Size`, `palette_Id`, `shade`, " +
                          "`obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z`)");

            var rows = new List<string>(generators.Count);
            foreach (var g in generators) {
                // Finding 9 clamp: PaletteTemplate (int?) → palette_Id (uint?), negatives → 0.
                // NOTE: 0 is itself a meaningful template, so this silently masks degenerate
                // upstream data. PR2 keeps the clamp (SPEC PR2 note); a proper range diagnostic is
                // deferred to the PR3 / E6 validation gate (SPEC §6), which is the designated home
                // for surfacing out-of-domain enrichment values.
                uint? paletteId = g.PaletteTemplate.HasValue
                    ? (uint)Math.Max(0, g.PaletteTemplate.Value)
                    : (uint?)null;

                // Match ACE WeenieSQLWriter.cs:780 + FixNullFields exactly: the column is uint?
                // (WeeniePropertiesGenerator.ObjCellId), so null → NULL, 0 → 0, >0 → hex 0x%08X.
                // ACE never collapses a null to 0 here.
                string objCellLiteral = !g.ObjCellId.HasValue
                    ? NullSentinel
                    : (g.ObjCellId.Value > 0 ? $"0x{g.ObjCellId.Value:X8}" : "0");

                rows.Add(
                    $"{weenieClassId}, " +
                    $"{FmtFloat6(g.Probability)}, " +
                    $"{g.WeenieClassId}, " +
                    $"{FmtFloat6OrNull(g.Delay)}, " +
                    $"{g.InitCreate}, " +
                    $"{g.MaxCreate}, " +
                    $"{g.WhenCreate}, " +
                    $"{g.WhereCreate}, " +
                    $"{FmtIntOrNull(g.StackSize)}, " +
                    $"{FmtUIntOrNull(paletteId)}, " +
                    $"{FmtFloat6OrNull(g.Shade)}, " +
                    $"{objCellLiteral}, " +
                    $"{FmtFloat6OrNull(g.OriginX)}, " +
                    $"{FmtFloat6OrNull(g.OriginY)}, " +
                    $"{FmtFloat6OrNull(g.OriginZ)}, " +
                    $"{FmtFloat6OrNull(g.AnglesW)}, " +
                    $"{FmtFloat6OrNull(g.AnglesX)}, " +
                    $"{FmtFloat6OrNull(g.AnglesY)}, " +
                    $"{FmtFloat6OrNull(g.AnglesZ)})");
            }
            AppendValues(sb, rows);
            return sb.ToString();
        }

        /// <summary>
        /// Emit the <c>weenie_properties_position</c> DELETE+INSERT for one wcid's PositionType map.
        /// One VALUES row per key, ordered ascending by the <see cref="PositionType"/> ushort so the
        /// output is deterministic (the in-memory dict already enforces UNIQUE(object_Id,
        /// position_Type)). <c>position_Type</c> is the raw ushort; <c>obj_Cell_Id</c> hex 0x%08X.
        /// Returns null when the map is empty.
        /// </summary>
        public static string? GeneratePositionSql(uint weenieClassId, IReadOnlyDictionary<PositionType, PlacementPosition>? positions) {
            if (positions is null || positions.Count == 0) return null;

            var sb = new StringBuilder();
            AppendDelete(sb, "weenie_properties_position", weenieClassId);
            sb.AppendLine("INSERT INTO `weenie_properties_position` (`object_Id`, `position_Type`, `obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z`)");

            var rows = new List<string>(positions.Count);
            foreach (var kv in positions.OrderBy(kv => (ushort)kv.Key)) {
                var p = kv.Value;
                rows.Add(
                    $"{weenieClassId}, {(ushort)kv.Key}, 0x{p.ObjCellId:X8}, " +
                    $"{FmtFloat6(p.OriginX)}, {FmtFloat6(p.OriginY)}, {FmtFloat6(p.OriginZ)}, " +
                    $"{FmtFloat6(p.AnglesW)}, {FmtFloat6(p.AnglesX)}, {FmtFloat6(p.AnglesY)}, {FmtFloat6(p.AnglesZ)})");
            }
            AppendValues(sb, rows);
            return sb.ToString();
        }

        /// <summary>
        /// Emit the <c>weenie_properties_int</c> DELETE+INSERT carrying ONLY the template tint
        /// (type=3 PaletteTemplate) for one wcid's dye. Returns null when the dye has no template
        /// index. Scoped narrowly (type=3 only) so we never clobber other int properties on the
        /// weenie — the DELETE targets the exact (object_Id, type) row.
        /// </summary>
        public static string? GeneratePaletteTemplateIntSql(uint weenieClassId, PlacementDye dye) {
            if (dye is null || !dye.PaletteTemplate.HasValue) return null;

            var sb = new StringBuilder();
            AppendDeleteTyped(sb, "weenie_properties_int", weenieClassId, PropertyInt_PaletteTemplate);
            sb.AppendLine("INSERT INTO `weenie_properties_int` (`object_Id`, `type`, `value`)");
            var rows = new List<string> {
                $"{weenieClassId}, {PropertyInt_PaletteTemplate}, {dye.PaletteTemplate.Value}) /* PaletteTemplate */",
            };
            AppendValues(sb, rows);
            return sb.ToString();
        }

        /// <summary>
        /// Emit the <c>weenie_properties_float</c> DELETE+INSERT carrying ONLY Shade (type=12) for
        /// one wcid's dye. Returns null when the dye has no shade. Value uses ACE's float property
        /// format <c>0.###</c> (WeenieSQLWriter.cs:263). The DELETE targets the exact (object_Id,
        /// type=12) row so other float properties are untouched.
        /// </summary>
        public static string? GenerateShadeFloatSql(uint weenieClassId, PlacementDye dye) {
            if (dye is null || !dye.Shade.HasValue) return null;

            var sb = new StringBuilder();
            AppendDeleteTyped(sb, "weenie_properties_float", weenieClassId, PropertyFloat_Shade);
            sb.AppendLine("INSERT INTO `weenie_properties_float` (`object_Id`, `type`, `value`)");
            var rows = new List<string> {
                $"{weenieClassId}, {PropertyFloat_Shade}, {FmtFloat3(dye.Shade.Value)}) /* Shade */",
            };
            AppendValues(sb, rows);
            return sb.ToString();
        }

        // ── Shared emit helpers (mirror SQLWriter.ValuesWriter / FixNullFields) ──

        private static void AppendDelete(StringBuilder sb, string table, uint weenieClassId) {
            sb.Append("DELETE FROM `").Append(table).Append("` WHERE `object_Id` = ")
              .Append(weenieClassId.ToString(CultureInfo.InvariantCulture)).AppendLine(";");
        }

        private static void AppendDeleteTyped(StringBuilder sb, string table, uint weenieClassId, int type) {
            sb.Append("DELETE FROM `").Append(table).Append("` WHERE `object_Id` = ")
              .Append(weenieClassId.ToString(CultureInfo.InvariantCulture))
              .Append(" AND `type` = ").Append(type.ToString(CultureInfo.InvariantCulture)).AppendLine(";");
        }

        /// <summary>
        /// Writes value lines exactly like ACE's <c>SQLWriter.ValuesWriter</c>: first row prefixed
        /// <c>VALUES (</c>, subsequent rows <c>     , (</c>, last row terminated <c>;</c>, then each
        /// line run through <see cref="FixNullFields"/>.
        /// </summary>
        private static void AppendValues(StringBuilder sb, IReadOnlyList<string> rows) {
            for (int i = 0; i < rows.Count; i++) {
                string line = (i == 0 ? "VALUES (" : "     , (") + rows[i];
                if (i == rows.Count - 1) line += ";";
                sb.AppendLine(FixNullFields(line));
            }
        }

        /// <summary>
        /// Mirror of ACE's <c>SQLWriter.FixNullFields</c> (SQLWriter.cs:93-105): collapses the
        /// empty-interpolation gaps an absent value would leave (", ," → ", NULL," and ", )" →
        /// ", NULL)") and strips empty comments. We already render <see cref="NullSentinel"/>
        /// inline, so this is belt-and-suspenders parity with ACE's exact post-pass.
        /// </summary>
        internal static string FixNullFields(string input) {
            input = input.Replace(", ,", ", NULL,");
            input = input.Replace(", ,", ", NULL,");
            input = input.Replace(", )", ", NULL)");
            input = input.Replace(" /*  */", "");
            return input;
        }
    }
}
