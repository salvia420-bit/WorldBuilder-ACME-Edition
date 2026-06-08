using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;

using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// E1 (wave-2) PR3 — RE-IMPORT: read the generated per-table enrichment SQL
    /// (<c>weenie_properties_*</c> Option A, or <c>biota_properties_*</c> Option B) back into
    /// editable <see cref="EnrichedPlacement"/> models, so the round-trip
    /// JSON ⇄ in-memory ⇄ SQL ⇄ in-memory is VALUE-EXACT (SPEC §4 "re-import is a pure deserialize").
    ///
    /// <para>Reversibility holds because every value the emitters write is positionless and
    /// addressable: dye = SubPaletteId DID + Offset + Length (+ type=3/type=12), generator = named
    /// columns, positions = a PositionType-keyed map. The parser reads the same column order the
    /// emitters write (one source of truth: the INSERT column lists in
    /// <c>AceDbConnector.EnrichmentSql</c> / <c>AceDbConnector.BiotaSql</c>).</para>
    ///
    /// <para>The parser is line-oriented and tolerant of the ACE-style <c>/* … */</c> crib comments
    /// the emitters append (they are stripped before tokenizing). It keys rows by the <c>object_Id</c>
    /// column — wcid for Option A, guid for Option B — and rebuilds one <see cref="EnrichedPlacement"/>
    /// per object_Id with the correct <see cref="EnrichmentScope"/>.</para>
    /// </summary>
    public static class EnrichmentSqlImporter {
        private sealed class Acc {
            public uint ObjectId;
            /// <summary>Recovered from biota.sql for Option B (the stub carries the real wcid); 0 until seen.</summary>
            public uint WeenieClassId;
            public PlacementDye? Dye;
            public List<PlacementGenerator>? Generators;
            public Dictionary<PositionType, PlacementPosition>? Positions;
            public PlacementDye EnsureDye() => Dye ??= new PlacementDye();
        }

        /// <summary>
        /// Read every per-table enrichment <c>.sql</c> in <paramref name="dir"/> (both Option A
        /// world tables and Option B biota tables) and rebuild the enriched placements. The
        /// <c>object_Id</c> becomes the placement's wcid (Option A) or guid (Option B). Returns the
        /// placements ordered by object_Id ascending (deterministic). Missing files are skipped.
        /// </summary>
        public static List<EnrichedPlacement> ReadDir(string dir) {
            var result = new List<EnrichedPlacement>();

            // ── Option A (world / weenie_properties_*) ──
            var weenie = new SortedDictionary<uint, Acc>();
            ParsePalette(Read(dir, AceDbConnector.PaletteSqlFileName), weenie, hasOrder: false);
            ParseTypedValue(Read(dir, AceDbConnector.IntSqlFileName), weenie, isShade: false);
            ParseTypedValue(Read(dir, AceDbConnector.FloatSqlFileName), weenie, isShade: true);
            ParseGenerator(Read(dir, AceDbConnector.GeneratorSqlFileName), weenie);
            ParsePosition(Read(dir, AceDbConnector.PositionSqlFileName), weenie);
            foreach (var (wcid, acc) in weenie)
                result.Add(ToPlacement(wcid, acc, EnrichmentScope.ClassDefault, guid: null));

            // ── Option B (shard / biota_properties_*) ──
            var biota = new SortedDictionary<uint, Acc>();
            // Parse the biota STUB first so the recovered wcid (and the existence of the override) is
            // seeded for every guid before the facet tables fill in the dye/generators/positions.
            ParseBiotaStub(Read(dir, AceDbConnector.BiotaSqlFileName), biota);
            ParsePalette(Read(dir, AceDbConnector.BiotaPaletteSqlFileName), biota, hasOrder: true);
            ParseTypedValue(Read(dir, AceDbConnector.BiotaIntSqlFileName), biota, isShade: false);
            ParseTypedValue(Read(dir, AceDbConnector.BiotaFloatSqlFileName), biota, isShade: true);
            ParseGenerator(Read(dir, AceDbConnector.BiotaGeneratorSqlFileName), biota);
            ParsePosition(Read(dir, AceDbConnector.BiotaPositionSqlFileName), biota);
            foreach (var (guid, acc) in biota)
                result.Add(ToPlacement(guid, acc, EnrichmentScope.PlacementOverride, guid: guid));

            return result;
        }

        private static EnrichedPlacement ToPlacement(uint objectId, Acc acc, EnrichmentScope scope, uint? guid) => new() {
            // The per-table SQL carries no pose/key (those live in landblock_instance / the JSONL).
            // object_Id is the wcid (Option A) or guid (Option B). For Option A the object_Id IS the
            // wcid; for Option B the wcid is recovered from the parsed biota STUB row (the only Option B
            // SQL artifact that carries the placement's wcid). Both are now self-describing.
            WeenieClassId = scope == EnrichmentScope.ClassDefault ? objectId : acc.WeenieClassId,
            // For Option B, the static guid also encodes the landblock: guid = 0x70000000 | (lb << 12) | seq.
            Landblock = scope == EnrichmentScope.PlacementOverride && guid is { } g
                ? (ushort)((g >> 12) & 0xFFFF)
                : (ushort)0,
            Guid = guid,
            Scope = scope,
            Dye = acc.Dye,
            Generators = acc.Generators,
            Positions = acc.Positions,
        };

        // ── File access ─────────────────────────────────────────────────────

        private static string? Read(string dir, string fileName) {
            var path = Path.Combine(dir, fileName);
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }

        // ── Row tokenizer ───────────────────────────────────────────────────

        /// <summary>
        /// Yield the comma-split value tokens of every VALUES row in an emitted per-table file. A
        /// VALUES row is a line starting with <c>VALUES (</c> or the continuation <c>     , (</c>.
        /// The trailing <c>)</c> / <c>);</c> and any <c>/* … */</c> crib are stripped first.
        /// </summary>
        private static IEnumerable<string[]> ValueRows(string? sql) {
            if (string.IsNullOrEmpty(sql)) yield break;
            foreach (var raw in sql!.Split('\n')) {
                var line = raw.TrimEnd('\r');
                string trimmed = line.TrimStart();
                string? inner = null;
                if (trimmed.StartsWith("VALUES (", StringComparison.Ordinal))
                    inner = trimmed.Substring("VALUES (".Length);
                else if (trimmed.StartsWith(", (", StringComparison.Ordinal))
                    inner = trimmed.Substring(", (".Length);
                if (inner == null) continue;

                // Strip the trailing crib comment, then the closing paren / semicolon.
                int crib = inner.IndexOf("/*", StringComparison.Ordinal);
                if (crib >= 0) inner = inner.Substring(0, crib);
                inner = inner.Trim();
                inner = inner.TrimEnd(';').Trim();
                if (inner.EndsWith(")", StringComparison.Ordinal))
                    inner = inner.Substring(0, inner.Length - 1);

                var tokens = inner.Split(',').Select(t => t.Trim()).ToArray();
                yield return tokens;
            }
        }

        // ── Token parsers (mirror the emitter formats) ──────────────────────

        private static uint U(string s) =>
            s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? uint.Parse(s.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture)
                : uint.Parse(s, CultureInfo.InvariantCulture);

        private static ushort Us(string s) => (ushort)U(s);

        private static int I(string s) => int.Parse(s, CultureInfo.InvariantCulture);

        private static float F(string s) => float.Parse(s, CultureInfo.InvariantCulture);

        private static bool IsNull(string s) => s.Equals("NULL", StringComparison.OrdinalIgnoreCase);

        private static uint? UN(string s) => IsNull(s) ? null : U(s);
        private static int? IN(string s) => IsNull(s) ? null : I(s);
        private static float? FN(string s) => IsNull(s) ? null : F(s);

        private static Acc AccFor(SortedDictionary<uint, Acc> map, uint objId) {
            if (!map.TryGetValue(objId, out var a)) { a = new Acc { ObjectId = objId }; map[objId] = a; }
            return a;
        }

        /// <summary>
        /// biota stub: (id, weenie_Class_Id, weenie_Type, populated_Collection_Flags). Recovers the
        /// per-placement override's wcid (the only Option B SQL artifact that carries it) and registers
        /// the guid so an override with a stub-but-no-facets still surfaces as a placement.
        /// </summary>
        private static void ParseBiotaStub(string? sql, SortedDictionary<uint, Acc> map) {
            foreach (var t in ValueRows(sql)) {
                if (t.Length < 2) continue;
                var acc = AccFor(map, U(t[0]));
                acc.WeenieClassId = U(t[1]);
            }
        }

        /// <summary>palette: (object_Id, sub_Palette_Id, offset, length [, order]).</summary>
        private static void ParsePalette(string? sql, SortedDictionary<uint, Acc> map, bool hasOrder) {
            foreach (var t in ValueRows(sql)) {
                if (t.Length < 4) continue;
                var acc = AccFor(map, U(t[0]));
                var dye = acc.EnsureDye();
                dye.SubPaletteId = U(t[1]);
                dye.Offset = Us(t[2]);
                dye.Length = Us(t[3]);
                // t[4] is `order` for biota; not modeled on PlacementDye (always 0 on emit).
            }
        }

        /// <summary>int/float typed property: (object_Id, type, value). type=3 → PaletteTemplate, type=12 → Shade.</summary>
        private static void ParseTypedValue(string? sql, SortedDictionary<uint, Acc> map, bool isShade) {
            foreach (var t in ValueRows(sql)) {
                if (t.Length < 3) continue;
                var acc = AccFor(map, U(t[0]));
                int type = I(t[1]);
                var dye = acc.EnsureDye();
                if (!isShade && type == AceDbConnector.PropertyInt_PaletteTemplate)
                    dye.PaletteTemplate = I(t[2]);
                else if (isShade && type == AceDbConnector.PropertyFloat_Shade)
                    dye.Shade = F(t[2]);
            }
        }

        /// <summary>
        /// generator: (object_Id, probability, [weenie|biota]_Class_Id, delay, init_Create,
        /// max_Create, when_Create, where_Create, stack_Size, palette_Id, shade, obj_Cell_Id,
        /// origin_X/Y/Z, angles_W/X/Y/Z). Column 3 name differs world vs shard but the position is
        /// the same (the spawn-target wcid).
        /// </summary>
        private static void ParseGenerator(string? sql, SortedDictionary<uint, Acc> map) {
            foreach (var t in ValueRows(sql)) {
                if (t.Length < 19) continue;
                var acc = AccFor(map, U(t[0]));
                acc.Generators ??= new List<PlacementGenerator>();
                int? paletteId = IN(t[9]); // palette_Id (clamped uint? on emit) → PaletteTemplate
                acc.Generators.Add(new PlacementGenerator {
                    Probability = F(t[1]),
                    WeenieClassId = U(t[2]),
                    Delay = FN(t[3]),
                    InitCreate = I(t[4]),
                    MaxCreate = I(t[5]),
                    WhenCreate = U(t[6]),
                    WhereCreate = U(t[7]),
                    StackSize = IN(t[8]),
                    PaletteTemplate = paletteId,
                    Shade = FN(t[10]),
                    ObjCellId = UN(t[11]),
                    OriginX = FN(t[12]),
                    OriginY = FN(t[13]),
                    OriginZ = FN(t[14]),
                    AnglesW = FN(t[15]),
                    AnglesX = FN(t[16]),
                    AnglesY = FN(t[17]),
                    AnglesZ = FN(t[18]),
                });
            }
        }

        /// <summary>position: (object_Id, position_Type, obj_Cell_Id, origin_X/Y/Z, angles_W/X/Y/Z).</summary>
        private static void ParsePosition(string? sql, SortedDictionary<uint, Acc> map) {
            foreach (var t in ValueRows(sql)) {
                if (t.Length < 10) continue;
                var acc = AccFor(map, U(t[0]));
                acc.Positions ??= new Dictionary<PositionType, PlacementPosition>();
                var key = (PositionType)Us(t[1]);
                acc.Positions[key] = new PlacementPosition {
                    ObjCellId = U(t[2]),
                    OriginX = F(t[3]), OriginY = F(t[4]), OriginZ = F(t[5]),
                    AnglesW = F(t[6]), AnglesX = F(t[7]), AnglesY = F(t[8]), AnglesZ = F(t[9]),
                };
            }
        }
    }
}
