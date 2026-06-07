using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// JSONL round-trip for <see cref="EnrichedPlacement"/> records — reads/writes
    /// <c>placements_enriched.jsonl</c>, the addressable source of truth for the E1 export
    /// pipeline (SPEC §4).
    ///
    /// The serializer is configured so a serialize → deserialize → serialize cycle is
    /// VALUE-EXACT:
    /// <list type="bullet">
    /// <item>enums (including the <see cref="PositionType"/> dictionary keys) round-trip by
    /// NAME via <see cref="JsonStringEnumConverter"/> — human/ML readable AND lossless;</item>
    /// <item>nulls are dropped on write (<see cref="JsonIgnoreCondition.WhenWritingNull"/>) and
    /// restored as null on read — so an absent dye/generator/position map stays absent;</item>
    /// <item>camelCase keys keep the JSON friendly to JS/TS/ML consumers (mirrors
    /// <c>WeenieIndex</c>'s JSONL).</item>
    /// </list>
    /// One JSON object per line. Lines are ordered deterministically (kind, landblock, cell,
    /// wcid, guid) so the file itself is byte-stable for a given placement set.
    /// </summary>
    public static class EnrichedPlacementStore {
        /// <summary>Canonical sidecar file name.</summary>
        public const string FileName = "placements_enriched.jsonl";

        /// <summary>
        /// Frozen options for the enriched-placement JSONL. Immutable after first use — do not
        /// mutate (mirrors the contract documented on <see cref="WorldBuilder.Shared.Lib.JsonOpts"/>).
        ///
        /// <para><see cref="JsonNumberHandling.AllowNamedFloatingPointLiterals"/> is set so that a
        /// non-finite float (NaN/Infinity that a degenerate quaternion/vector normalize can
        /// legitimately produce upstream) round-trips as a named literal ("NaN"/"Infinity") rather
        /// than aborting the whole JSONL write — preserving the value-exact round-trip contract.</para>
        ///
        /// <para>The <see cref="OrderedPositionsConverter"/> writes the <see cref="PositionType"/>
        /// keys of the <c>Positions</c> map in ASCENDING enum-value order so the JSONL is
        /// byte-stable for a given logical placement regardless of the dictionary's insertion
        /// order (SPEC §4 "no ordering ambiguity").</para>
        /// </summary>
        public static readonly JsonSerializerOptions JsonOptions = new() {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
            WriteIndented = false,
            Converters = { new JsonStringEnumConverter(), new OrderedPositionsConverter() },
        };

        /// <summary>
        /// Serializes a <c>Dictionary&lt;PositionType, PlacementPosition&gt;</c> with its keys in
        /// ascending enum-value (ushort) order so two logically-identical position maps built in
        /// different insertion order produce byte-identical JSON. Reads back into a plain
        /// <see cref="Dictionary{TKey,TValue}"/> (insertion order = file order = sorted), so the
        /// round-trip is value-exact AND cross-run reproducible. Keys are written by enum NAME to
        /// match <see cref="JsonStringEnumConverter"/> readability.
        /// </summary>
        private sealed class OrderedPositionsConverter
            : JsonConverter<Dictionary<PositionType, PlacementPosition>> {
            public override Dictionary<PositionType, PlacementPosition> Read(
                ref Utf8JsonReader reader, System.Type typeToConvert, JsonSerializerOptions options) {
                var dict = new Dictionary<PositionType, PlacementPosition>();
                if (reader.TokenType != JsonTokenType.StartObject)
                    throw new JsonException("Expected StartObject for Positions map.");
                while (reader.Read()) {
                    if (reader.TokenType == JsonTokenType.EndObject) return dict;
                    if (reader.TokenType != JsonTokenType.PropertyName)
                        throw new JsonException("Expected PropertyName in Positions map.");
                    var keyName = reader.GetString()!;
                    if (!System.Enum.TryParse<PositionType>(keyName, ignoreCase: false, out var key)
                        && !System.Enum.TryParse(keyName, ignoreCase: true, out key)) {
                        // Tolerate a numeric key for forward/hand-authored compatibility.
                        if (ushort.TryParse(keyName, out var raw)) key = (PositionType)raw;
                        else throw new JsonException($"Unknown PositionType key '{keyName}'.");
                    }
                    reader.Read();
                    var value = JsonSerializer.Deserialize<PlacementPosition>(ref reader, options)!;
                    dict[key] = value;
                }
                throw new JsonException("Unexpected end of Positions map.");
            }

            public override void Write(
                Utf8JsonWriter writer, Dictionary<PositionType, PlacementPosition> value, JsonSerializerOptions options) {
                writer.WriteStartObject();
                foreach (var kv in value.OrderBy(kv => (ushort)kv.Key)) {
                    writer.WritePropertyName(kv.Key.ToString());
                    JsonSerializer.Serialize(writer, kv.Value, options);
                }
                writer.WriteEndObject();
            }
        }

        // ── Serialization (value-exact) ────────────────────────────────────

        /// <summary>Serialize one record to a single JSONL line (no trailing newline).</summary>
        public static string SerializeLine(EnrichedPlacement placement) =>
            JsonSerializer.Serialize(placement, JsonOptions);

        /// <summary>Deserialize one JSONL line back to a record.</summary>
        public static EnrichedPlacement? DeserializeLine(string line) =>
            JsonSerializer.Deserialize<EnrichedPlacement>(line, JsonOptions);

        /// <summary>
        /// Serialize a set of records to the full JSONL text (one object per line, ordered
        /// deterministically). Returns the text rather than writing it so callers control IO
        /// (and tests can diff in memory).
        /// </summary>
        public static string Serialize(IEnumerable<EnrichedPlacement> placements) {
            var sb = new StringBuilder();
            foreach (var p in Order(placements))
                sb.Append(SerializeLine(p)).Append('\n');
            return sb.ToString();
        }

        /// <summary>Deserialize full JSONL text back into records (blank lines skipped).</summary>
        public static List<EnrichedPlacement> Deserialize(string jsonl) {
            var list = new List<EnrichedPlacement>();
            foreach (var raw in jsonl.Split('\n')) {
                var line = raw.Trim();
                if (line.Length == 0) continue;
                var p = DeserializeLine(line);
                if (p != null) list.Add(p);
            }
            return list;
        }

        // ── File IO ────────────────────────────────────────────────────────

        /// <summary>
        /// Write the records to <c>placements_enriched.jsonl</c> under <paramref name="outDir"/>.
        /// Returns the full path written.
        /// </summary>
        public static string WriteFile(string outDir, IEnumerable<EnrichedPlacement> placements) {
            Directory.CreateDirectory(outDir);
            var path = Path.Combine(outDir, FileName);
            File.WriteAllText(path, Serialize(placements), new UTF8Encoding(false));
            return path;
        }

        /// <summary>
        /// Read <c>placements_enriched.jsonl</c> from <paramref name="inputPath"/>
        /// (a directory or the file itself). Returns an empty list when the file is absent.
        /// </summary>
        public static List<EnrichedPlacement> ReadFile(string inputPath) {
            var path = Directory.Exists(inputPath) ? Path.Combine(inputPath, FileName) : inputPath;
            if (!File.Exists(path)) return new List<EnrichedPlacement>();
            return Deserialize(File.ReadAllText(path));
        }

        // ── Conversion: in-memory placement model ⇄ EnrichedPlacement ──────

        /// <summary>Project an outdoor placement to its addressable enriched record.</summary>
        public static EnrichedPlacement FromOutdoor(OutdoorInstancePlacement p, EnrichmentScope scope = EnrichmentScope.ClassDefault) => new() {
            Kind = "outdoor",
            Landblock = p.LandblockId,
            CellNumber = p.CellNumber,
            WeenieClassId = p.WeenieClassId,
            OriginX = p.OriginX,
            OriginY = p.OriginY,
            OriginZ = p.OriginZ,
            AnglesW = p.AnglesW,
            AnglesX = p.AnglesX,
            AnglesY = p.AnglesY,
            AnglesZ = p.AnglesZ,
            Dye = p.Dye,
            Generators = p.Generators,
            Positions = p.Positions,
            Scope = scope,
        };

        /// <summary>Project a dungeon placement to its addressable enriched record.</summary>
        public static EnrichedPlacement FromDungeon(ushort landblockId, DungeonInstancePlacement p, EnrichmentScope scope = EnrichmentScope.ClassDefault) {
            var q = p.Orientation;
            return new EnrichedPlacement {
                Kind = "dungeon",
                Landblock = landblockId,
                CellNumber = p.CellNumber,
                WeenieClassId = p.WeenieClassId,
                OriginX = p.Origin.X,
                OriginY = p.Origin.Y,
                OriginZ = p.Origin.Z,
                AnglesW = q.W,
                AnglesX = q.X,
                AnglesY = q.Y,
                AnglesZ = q.Z,
                Dye = p.Dye,
                Generators = p.Generators,
                Positions = p.Positions,
                Scope = scope,
            };
        }

        /// <summary>
        /// Rebuild the orientation quaternion from the enriched record's nullable angles.
        /// When ALL four angles are absent (a hand-authored / ML-emitted line that omits
        /// rotation), fall back to the ACE identity quaternion (x=0,y=0,z=0,w=1) — the same
        /// all-null → identity rule the SQL emitter uses (AceDbConnector.GenerateInsertSql).
        /// When any component is present, use it with identity defaults for the rest.
        /// </summary>
        private static Quaternion RebuildOrientation(EnrichedPlacement e) =>
            (e.AnglesW is null && e.AnglesX is null && e.AnglesY is null && e.AnglesZ is null)
                ? Quaternion.Identity
                : new Quaternion(e.AnglesX ?? 0f, e.AnglesY ?? 0f, e.AnglesZ ?? 0f, e.AnglesW ?? 1f);

        /// <summary>Rebuild an outdoor placement from an enriched record (the read-back path).</summary>
        public static OutdoorInstancePlacement ToOutdoor(EnrichedPlacement e) {
            var q = RebuildOrientation(e);
            return new OutdoorInstancePlacement {
                LandblockId = e.Landblock,
                WeenieClassId = e.WeenieClassId,
                CellNumber = e.CellNumber,
                OriginX = e.OriginX,
                OriginY = e.OriginY,
                OriginZ = e.OriginZ,
                AnglesW = q.W,
                AnglesX = q.X,
                AnglesY = q.Y,
                AnglesZ = q.Z,
                Dye = e.Dye,
                Generators = e.Generators,
                Positions = e.Positions,
            };
        }

        /// <summary>Rebuild a dungeon placement from an enriched record (the read-back path).</summary>
        public static DungeonInstancePlacement ToDungeon(EnrichedPlacement e) => new() {
            WeenieClassId = e.WeenieClassId,
            CellNumber = e.CellNumber,
            Origin = new Vector3(e.OriginX, e.OriginY, e.OriginZ),
            Orientation = RebuildOrientation(e),
            Dye = e.Dye,
            Generators = e.Generators,
            Positions = e.Positions,
        };

        private static IEnumerable<EnrichedPlacement> Order(IEnumerable<EnrichedPlacement> placements) =>
            placements
                .OrderBy(p => p.Kind, System.StringComparer.Ordinal)
                .ThenBy(p => p.Landblock)
                .ThenBy(p => p.CellNumber)
                .ThenBy(p => p.WeenieClassId)
                .ThenBy(p => p.Guid ?? 0u)
                // Final deterministic tie-break over the full pose so two distinct placements that
                // share the same (Kind, Landblock, CellNumber, WeenieClassId) and have no Guid
                // (legal: two copies of the same wcid stacked in one cell) still sort stably,
                // independent of input order.
                .ThenBy(p => p.OriginX)
                .ThenBy(p => p.OriginY)
                .ThenBy(p => p.OriginZ)
                .ThenBy(p => p.AnglesW ?? 0f)
                .ThenBy(p => p.AnglesX ?? 0f)
                .ThenBy(p => p.AnglesY ?? 0f)
                .ThenBy(p => p.AnglesZ ?? 0f);
    }
}
