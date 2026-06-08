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
    /// <item><c>biota_properties_generator</c>'s 3rd column is <c>weenie_Class_Id</c> — matching the
    /// live ACE shard table (<c>Database/Base/ShardBase.sql</c> + entity
    /// <c>BiotaPropertiesGenerator.WeenieClassId</c>). NB: ACE's own <c>BiotaSQLWriter.cs:611</c> emits
    /// <c>biota_Class_Id</c>, but that name is inconsistent with the actual shard column, so a LIVE
    /// INSERT must use <c>weenie_Class_Id</c> or it fails with "Unknown column 'biota_Class_Id'";</item>
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
        public const string BiotaDidSqlFileName = "biota_properties_d_i_d.sql";
        public const string BiotaStringSqlFileName = "biota_properties_string.sql";

        /// <summary><c>PropertyDataId.Setup</c> — the Setup (GfxObj/SetupModel) DID property type.</summary>
        public const int PropertyDataId_Setup = 1;
        /// <summary><c>PropertyString.Name</c> — the object's display-name string property type.</summary>
        public const int PropertyString_Name = 1;

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

        // ── biota_properties_generator (weenie_Class_Id) ────────────────────

        /// <summary>
        /// Emit <c>biota_properties_generator</c> for one placement's generator profiles. The 3rd
        /// column is <c>weenie_Class_Id</c> (the spawn-target wcid), matching the live ACE shard table
        /// (ShardBase.sql / BiotaPropertiesGenerator entity) — NOT ACE's BiotaSQLWriter.cs:611, which
        /// emits the schema-inconsistent <c>biota_Class_Id</c> and would fail a live INSERT. PaletteTemplate is
        /// clamped to ACE's uint? domain (negatives → 0); the negative-clamp DIAGNOSTIC is surfaced
        /// by the validation/exporter layer, not here. Returns null when there are no profiles.
        /// </summary>
        public static string? GenerateBiotaGeneratorSql(uint guid, IReadOnlyList<PlacementGenerator>? generators) {
            if (generators is null || generators.Count == 0) return null;

            var sb = new StringBuilder();
            AppendBiotaDelete(sb, "biota_properties_generator", guid);
            sb.AppendLine("INSERT INTO `biota_properties_generator` (`object_Id`, `probability`, `weenie_Class_Id`, " +
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

        // ── biota_properties_d_i_d (Setup, type=1) — Option-B BASE COPY ──────

        /// <summary>
        /// Emit <c>biota_properties_d_i_d</c> carrying the base weenie's <c>Setup</c> DID
        /// (<see cref="PropertyDataId_Setup"/>, type=1) for one placement's object.
        ///
        /// <para>WHY (the rendering unblock): ACE static biotas are FULL self-contained snapshots —
        /// <c>WorldObjectFactory.CreateWorldObject(biota)</c> + <c>BiotaConverter</c> build the object
        /// purely from the stored biota rows with NO weenie merge. Option B's sparse biota (stub + only
        /// the diverging palette/generator/position/dye facets) therefore has NO Setup DID, and the
        /// server fails to spawn it ("Unable to find object_id 00000000 in Portal" — the documented
        /// deferred limitation at CommandEngine.Placements.cs). Copying the base weenie's Setup DID into
        /// the biota gives the object a model to render, which is the minimal viable spawn.</para>
        ///
        /// <para>OFFLINE-ONLY: <paramref name="setupDid"/> is resolved from the ingested
        /// <see cref="Lib.WeenieIndex"/> (which carries SetupDid for ~all weenies) — NO live DB. A FULL
        /// base-weenie property copy (all ints/floats/strings/positions) needs the full weenie record
        /// (live DB) and stays DEFERRED. This is the Setup-DID increment only.</para>
        ///
        /// <para>The DELETE targets the exact (object_Id, type=1) row so other DID properties stay
        /// untouched (idempotent replace).</para>
        ///
        /// Returns null when <paramref name="setupDid"/> is 0 (no Setup in the index — nothing to copy).
        /// </summary>
        public static string? GenerateBiotaSetupDidSql(uint guid, uint setupDid) {
            if (setupDid == 0) return null;

            var sb = new StringBuilder();
            AppendBiotaDeleteTyped(sb, "biota_properties_d_i_d", guid, PropertyDataId_Setup);
            sb.AppendLine("INSERT INTO `biota_properties_d_i_d` (`object_Id`, `type`, `value`)");
            var rows = new List<string> {
                $"{guid}, {PropertyDataId_Setup}, {setupDid}) /* Setup 0x{setupDid:X8} */",
            };
            AppendValues(sb, rows);
            return sb.ToString();
        }

        // ── biota_properties_string (Name, type=1) — Option-B BASE COPY ──────

        /// <summary>
        /// Emit <c>biota_properties_string</c> carrying the base weenie's <c>Name</c>
        /// (<see cref="PropertyString_Name"/>, type=1) for one placement's object. Cheap identity copy
        /// from the same offline <see cref="Lib.WeenieIndex"/> (the index carries a DisplayName for ~all
        /// weenies) so the spawned static object has a label without a live-DB read.
        ///
        /// <para>The value is single-quote escaped (doubled quotes + escaped backslash) — the ONLY
        /// string-bearing biota emitter, so it is the only one that needs literal escaping; every other
        /// Option-B value is a numeric literal. The DELETE targets the exact (object_Id, type=1) row.</para>
        ///
        /// Returns null when <paramref name="name"/> is null/blank (nothing to copy).
        /// </summary>
        public static string? GenerateBiotaNameStringSql(uint guid, string? name) {
            if (string.IsNullOrWhiteSpace(name)) return null;

            var sb = new StringBuilder();
            AppendBiotaDeleteTyped(sb, "biota_properties_string", guid, PropertyString_Name);
            sb.AppendLine("INSERT INTO `biota_properties_string` (`object_Id`, `type`, `value`)");
            var rows = new List<string> {
                $"{guid}, {PropertyString_Name}, '{EscapeSqlString(name)}') /* Name */",
            };
            AppendValues(sb, rows);
            return sb.ToString();
        }

        /// <summary>
        /// Escape a string for a single-quoted MySQL literal: backslash and single-quote are doubled
        /// (ANSI/MySQL both honor <c>''</c>; backslash is escaped for MySQL's default backslash mode).
        /// The only user/DB text reaching Option-B SQL is the weenie Name, routed through here.
        /// </summary>
        private static string EscapeSqlString(string s) =>
            s.Replace("\\", "\\\\").Replace("'", "''");

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
