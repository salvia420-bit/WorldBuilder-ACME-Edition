using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// E1 (wave-2) PR3 — per-PLACEMENT (Option B / <see cref="EnrichmentScope.PlacementOverride"/>)
    /// SHARD-DB biota override SQL emitters. These mirror the PR2 per-class
    /// <c>weenie_properties_*</c> emitters (<see cref="AceDbConnector"/> EnrichmentSql partial) but
    /// target ACE's SHARD <c>biota</c> + <c>biota_properties_*</c> tables, keyed by the placement
    /// GUID (<c>biota.id == landblock_instance.guid</c>, SPEC §2.3/§2.4).
    ///
    /// <para>WHERE/WORLD-vs-SHARD (HARD CONSTRAINT 3): the per-class default goes to the WORLD DB
    /// (<c>weenie_properties_*</c>, PR2); a per-placement OVERRIDE goes to the SHARD DB
    /// (<c>biota_properties_*</c>, here). They are NEVER crossed — these emitters produce only
    /// <c>biota*</c> table SQL, and the import/apply wiring routes them to the shard connection.</para>
    ///
    /// <para>FORMAT FIDELITY (HARD CONSTRAINT 2/4): the column lists and ordering match ACE's
    /// <c>ACE.Database/SQLFormatters/Shard/BiotaSQLWriter</c>:
    /// <list type="bullet">
    /// <item><c>biota</c> = <c>(id, weenie_Class_Id, weenie_Type, populated_Collection_Flags)</c>,
    /// default flags <c>4294967295</c> (BiotaSQLWriter.cs:45-48);</item>
    /// <item><c>biota_properties_palette</c> adds an <c>order</c> column the weenie table lacks
    /// (BiotaSQLWriter.cs:655);</item>
    /// <item><c>biota_properties_generator</c>'s 3rd column is <c>biota_Class_Id</c> (NOT
    /// <c>weenie_Class_Id</c>) — BiotaSQLWriter.cs:611;</item>
    /// <item><c>biota_properties_position</c> / <c>_int</c> (type=3) / <c>_float</c> (type=12)
    /// mirror the weenie shapes.</item>
    /// </list>
    /// Numeric formatting, hex/decimal rules, the <c>VALUES (…)</c>/<c>     , (…)</c> value-line
    /// shape, <c>FixNullFields</c>, and the non-finite-float guard are SHARED with the PR2 emitters
    /// (this is the same <see cref="AceDbConnector"/> partial class).</para>
    ///
    /// <para>IDEMPOTENCY: each emit is a DELETE+INSERT. The biota stub DELETEs <c>biota</c> by id
    /// (which FK-cascades to the property tables in a real ACE shard, mirroring
    /// BiotaSQLWriter.CreateSQLDELETEStatement:40); per-property emitters ALSO emit a scoped DELETE
    /// (by object_Id, or by object_Id+type for int/float) so a single property file is replayable on
    /// its own without the stub.</para>
    /// </summary>
    public partial class AceDbConnector {
        /// <summary>The default ACE shard database name (Option B target).</summary>
        public const string ShardDbName = "ace_shard";

        // ── Per-placement (Option B) biota file names (one ACE shard table each) ──
        public const string BiotaSqlFileName = "biota.sql";
        public const string BiotaPaletteSqlFileName = "biota_properties_palette.sql";
        public const string BiotaGeneratorSqlFileName = "biota_properties_generator.sql";
        public const string BiotaPositionSqlFileName = "biota_properties_position.sql";
        public const string BiotaIntSqlFileName = "biota_properties_int.sql";
        public const string BiotaFloatSqlFileName = "biota_properties_float.sql";

        /// <summary>
        /// ACE biota default <c>populated_Collection_Flags</c> when none are set (all-flags sentinel,
        /// BiotaSQLWriter.cs:48). For a WB-minted stub we let ACE repopulate from the weenie, so the
        /// all-flags default is the correct conservative value.
        /// </summary>
        public const uint BiotaPopulatedCollectionFlagsAll = 4294967295u;

        // ── Biota stub row ──────────────────────────────────────────────────

        /// <summary>
        /// Emit the <c>biota</c> stub UPSERT for one placement override:
        /// <c>(id=guid, weenie_Class_Id=wcid, weenie_Type, populated_Collection_Flags)</c>.
        ///
        /// <para>IDEMPOTENCY (non-destructive): this is an <c>INSERT … ON DUPLICATE KEY UPDATE</c> on
        /// the <c>biota</c> PARENT row — NOT a <c>DELETE FROM biota</c>. In a real ACE shard every
        /// <c>biota_properties_*</c> table FK-cascades <c>ON DELETE CASCADE</c> from <c>biota.id</c>;
        /// a DELETE+INSERT on the parent would cascade-wipe EVERY persisted child of that object
        /// (attributes, skills, name/setup DIDs, …), and Option B only re-inserts the five diverging
        /// facets. Upserting the parent preserves the object's other persisted state; per-facet
        /// idempotency is handled by the scoped DELETEs the per-property emitters already emit.</para>
        ///
        /// <para><paramref name="weenieType"/> is REQUIRED to be a real, non-Undef ACE
        /// <c>WeenieType</c>. ACE's <c>WorldObjectFactory.CreateWorldObject(Biota)</c> switches on
        /// <c>biota.WeenieType</c> and returns <c>null</c> for <c>WeenieType.Undef</c>
        /// (WorldObjectFactory.cs:154-155); <c>BiotaConverter</c> builds the object purely from the
        /// stored biota with NO weenie reconciliation. So a stub with <c>weenie_Type = 0</c> would
        /// produce a NULL WorldObject and the placement would silently vanish. The exporter resolves
        /// the real type from the offline WeenieIndex and passes it here.</para>
        /// </summary>
        public static string GenerateBiotaStubSql(uint guid, uint weenieClassId, int weenieType) {
            var sb = new StringBuilder();
            sb.AppendLine("INSERT INTO `biota` (`id`, `weenie_Class_Id`, `weenie_Type`, `populated_Collection_Flags`)");
            sb.AppendLine(FixNullFields(
                $"VALUES ({guid}, {weenieClassId}, {weenieType}, {BiotaPopulatedCollectionFlagsAll})"));
            // Non-destructive upsert: keep the parent row (and its cascaded children) on re-apply,
            // only refresh the identity columns. The diverging facet rows are replaced by the
            // per-property scoped DELETE+INSERT emitters.
            sb.Append("ON DUPLICATE KEY UPDATE `weenie_Class_Id` = ")
              .Append(weenieClassId.ToString(CultureInfo.InvariantCulture))
              .Append(", `weenie_Type` = ").Append(weenieType.ToString(CultureInfo.InvariantCulture))
              .Append(';').Append('\n');
            return sb.ToString();
        }

        // ── biota_properties_palette (adds `order`) ─────────────────────────

        /// <summary>
        /// Emit <c>biota_properties_palette</c> for one placement's SubPalette remap. Same shape as
        /// the weenie palette emitter but with ACE's extra <c>order</c> column (BiotaSQLWriter.cs:655),
        /// defaulted to 0. Returns null when the dye carries no addressable SubPaletteId.
        /// </summary>
        public static string? GenerateBiotaPaletteSql(uint guid, PlacementDye dye) {
            if (dye is null || !dye.SubPaletteId.HasValue) return null;

            var sb = new StringBuilder();
            AppendBiotaDelete(sb, "biota_properties_palette", guid);
            sb.AppendLine("INSERT INTO `biota_properties_palette` (`object_Id`, `sub_Palette_Id`, `offset`, `length`, `order`)");
            var rows = new List<string> {
                $"{guid}, {dye.SubPaletteId.Value}, {dye.Offset}, {dye.Length}, 0)" +
                $" /* sub_Palette_Id 0x{dye.SubPaletteId.Value:X8} */",
            };
            AppendValues(sb, rows);
            return sb.ToString();
        }

        // ── biota_properties_generator (biota_Class_Id) ─────────────────────

        /// <summary>
        /// Emit <c>biota_properties_generator</c> for one placement's generator profiles. Identical
        /// to the weenie generator emitter EXCEPT the 3rd column is named <c>biota_Class_Id</c>
        /// (BiotaSQLWriter.cs:611) — the VALUE is still the spawn-target wcid. PaletteTemplate is
        /// clamped to ACE's uint? domain (negatives → 0); the negative-clamp DIAGNOSTIC is surfaced
        /// by the validation/exporter layer, not here. Returns null when there are no profiles.
        /// </summary>
        public static string? GenerateBiotaGeneratorSql(uint guid, IReadOnlyList<PlacementGenerator>? generators) {
            if (generators is null || generators.Count == 0) return null;

            var sb = new StringBuilder();
            AppendBiotaDelete(sb, "biota_properties_generator", guid);
            sb.AppendLine("INSERT INTO `biota_properties_generator` (`object_Id`, `probability`, `biota_Class_Id`, " +
                          "`delay`, `init_Create`, `max_Create`, `when_Create`, `where_Create`, `stack_Size`, `palette_Id`, `shade`, " +
                          "`obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z`)");

            var rows = new List<string>(generators.Count);
            foreach (var g in generators) {
                uint? paletteId = g.PaletteTemplate.HasValue
                    ? (uint)Math.Max(0, g.PaletteTemplate.Value)
                    : (uint?)null;

                string objCellLiteral = !g.ObjCellId.HasValue
                    ? NullSentinel
                    : (g.ObjCellId.Value > 0 ? $"0x{g.ObjCellId.Value:X8}" : "0");

                rows.Add(
                    $"{guid}, " +
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

        // ── biota_properties_position ───────────────────────────────────────

        /// <summary>
        /// Emit <c>biota_properties_position</c> for one placement's PositionType map (same shape as
        /// the weenie position emitter). One VALUES row per key, ordered ascending by the
        /// <see cref="PositionType"/> ushort. Returns null when the map is empty.
        /// </summary>
        public static string? GenerateBiotaPositionSql(uint guid, IReadOnlyDictionary<PositionType, PlacementPosition>? positions) {
            if (positions is null || positions.Count == 0) return null;

            var sb = new StringBuilder();
            AppendBiotaDelete(sb, "biota_properties_position", guid);
            sb.AppendLine("INSERT INTO `biota_properties_position` (`object_Id`, `position_Type`, `obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z`)");

            var rows = new List<string>(positions.Count);
            foreach (var kv in positions.OrderBy(kv => (ushort)kv.Key)) {
                var p = kv.Value;
                rows.Add(
                    $"{guid}, {(ushort)kv.Key}, 0x{p.ObjCellId:X8}, " +
                    $"{FmtFloat6(p.OriginX)}, {FmtFloat6(p.OriginY)}, {FmtFloat6(p.OriginZ)}, " +
                    $"{FmtFloat6(p.AnglesW)}, {FmtFloat6(p.AnglesX)}, {FmtFloat6(p.AnglesY)}, {FmtFloat6(p.AnglesZ)})");
            }
            AppendValues(sb, rows);
            return sb.ToString();
        }

        // ── biota_properties_int (type=3 PaletteTemplate) ───────────────────

        /// <summary>
        /// Emit <c>biota_properties_int</c> carrying ONLY the template tint (type=3 PaletteTemplate)
        /// for one placement's dye. Returns null when the dye has no template index. The DELETE
        /// targets the exact (object_Id, type=3) row so other int properties stay untouched.
        /// </summary>
        public static string? GenerateBiotaPaletteTemplateIntSql(uint guid, PlacementDye dye) {
            if (dye is null || !dye.PaletteTemplate.HasValue) return null;

            var sb = new StringBuilder();
            AppendBiotaDeleteTyped(sb, "biota_properties_int", guid, PropertyInt_PaletteTemplate);
            sb.AppendLine("INSERT INTO `biota_properties_int` (`object_Id`, `type`, `value`)");
            var rows = new List<string> {
                $"{guid}, {PropertyInt_PaletteTemplate}, {dye.PaletteTemplate.Value}) /* PaletteTemplate */",
            };
            AppendValues(sb, rows);
            return sb.ToString();
        }

        // ── biota_properties_float (type=12 Shade) ──────────────────────────

        /// <summary>
        /// Emit <c>biota_properties_float</c> carrying ONLY Shade (type=12) for one placement's dye.
        /// Returns null when the dye has no shade. The DELETE targets the exact (object_Id, type=12)
        /// row so other float properties stay untouched.
        /// </summary>
        public static string? GenerateBiotaShadeFloatSql(uint guid, PlacementDye dye) {
            if (dye is null || !dye.Shade.HasValue) return null;

            var sb = new StringBuilder();
            AppendBiotaDeleteTyped(sb, "biota_properties_float", guid, PropertyFloat_Shade);
            sb.AppendLine("INSERT INTO `biota_properties_float` (`object_Id`, `type`, `value`)");
            var rows = new List<string> {
                $"{guid}, {PropertyFloat_Shade}, {FmtFloat3(dye.Shade.Value)}) /* Shade */",
            };
            AppendValues(sb, rows);
            return sb.ToString();
        }

        // ── Shared biota DELETE helpers (object_Id keyed by the placement guid) ──

        private static void AppendBiotaDelete(StringBuilder sb, string table, uint guid) {
            sb.Append("DELETE FROM `").Append(table).Append("` WHERE `object_Id` = ")
              .Append(guid.ToString(CultureInfo.InvariantCulture)).AppendLine(";");
        }

        private static void AppendBiotaDeleteTyped(StringBuilder sb, string table, uint guid, int type) {
            sb.Append("DELETE FROM `").Append(table).Append("` WHERE `object_Id` = ")
              .Append(guid.ToString(CultureInfo.InvariantCulture))
              .Append(" AND `type` = ").Append(type.ToString(CultureInfo.InvariantCulture)).AppendLine(";");
        }
    }
}
