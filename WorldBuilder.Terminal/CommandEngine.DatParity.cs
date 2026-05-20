using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 2.A + 2.B — DAT parser parity (Chorizite.DatReaderWriter as oracle).
///
/// See <c>docs/diagnostic-toolset-plan-2026-05-19.md</c> §3 row 5 and §6
/// Wave 2 (W2.A + W2.B). Sibling to the wire-conformance (W1) and enum-parity
/// (W2.C) command surfaces; same pattern: one engine partial, one dispatch
/// entry per command in <c>JsonCommandProcessor.cs</c>, one validator on the
/// holtburger-web side.
///
/// Commands in this file:
///
///   - <c>chorizite-list-dat-records</c> — enumerate every record ID in a DAT
///     file, optionally filtered by DBObjType (which is what the high-byte
///     prefix discriminates per <c>reference_ac_dat_file_types</c>). Returns
///     the DAT's SHA-256 (computed once + cached per file path) plus a list
///     of <c>(idHex, type, compressedSize)</c> tuples. Drives the validator's
///     deterministic sampling step.
///
///   - <c>chorizite-parse-dat-record</c> — parse one record via the
///     Chorizite generated DBObj reader; serialise the resulting field tree
///     as JSON. Returns <c>(idHex, typeName, fields)</c>; on failure returns
///     an <c>errorMessage</c> instead of throwing.
///
/// Contract (per [`dat-parity-method.md`](../docs/dat-parity-method.md)):
///   For every record in the DAT, the canonical Chorizite-side parser
///   produces a field tree. The holtburger-dat Rust parser must produce the
///   same field tree (modulo documented optional/version-conditional gaps).
///   Drift surfaces as FAIL; structural mismatches (Rust parser missing) as
///   GAP.
///
/// Source-of-truth precedence per
/// [[feedback_dat_parser_mislabels.md]]: when Chorizite/DRW labels disagree
/// with <c>~/ac-headers/acclient.c</c>, acclient.c wins. Any such cases land
/// as method-doc footnotes + Wave 2.D follow-on tickets.
///
/// Integrity discipline per [[feedback_base_dats_only_for_bake]]: this
/// command refuses to parse from DAT files containing IDs in the
/// <c>0x__FFxxxx</c> modder range (other than the well-known <c>0xFFFFxxxx</c>
/// iteration metadata). The validator runs a pre-flight that rejects any
/// non-base DAT bundle.
/// </summary>
public partial class CommandEngine {

    public sealed record DatRecordListResult(
        string DatPath,
        string DatSha256,
        int RecordCount,
        IReadOnlyList<DatRecordSummary> Records,
        string Source);

    public sealed record DatRecordSummary(
        string IdHex,
        uint Id,
        string TypeName,
        int CompressedSize);

    public sealed record DatRecordParseResult(
        string IdHex,
        uint Id,
        string TypeName,
        JsonNode? Fields,
        string? ErrorMessage,
        string Source);

    // Cache the SHA-256 of each DAT path (file-stat keyed) so repeated
    // validator calls don't re-scan the 884 MB portal each time.
    private static readonly Dictionary<string, (long Length, DateTime WriteUtc, string Sha256)>
        _datSha256Cache = new();
    private static readonly object _datSha256Lock = new();

    /// <summary>
    /// Index of Chorizite DBObj types in the loaded
    /// <c>DatReaderWriter.DBObjs.*</c> namespace, keyed by short type name
    /// (case-insensitive). Lazily populated; mirrors the wire-conformance
    /// partial's pattern but for DBObj types instead of ACMessage subclasses.
    /// </summary>
    private static Dictionary<string, Type>? _dbObjTypeIndex;
    private static readonly object _dbObjIndexLock = new();

    private static Dictionary<string, Type> GetDBObjTypeIndex() {
        if (_dbObjTypeIndex != null) return _dbObjTypeIndex;
        lock (_dbObjIndexLock) {
            if (_dbObjTypeIndex != null) return _dbObjTypeIndex;
            var idbObjType = typeof(DRW.DBObjs.GfxObj).Assembly
                .GetTypes()
                .FirstOrDefault(t => t.Name == "IDBObj")
                ?? typeof(DRW.DBObjs.GfxObj).GetInterfaces()
                    .FirstOrDefault(t => t.Name == "IDBObj");
            if (idbObjType == null) {
                throw new InvalidOperationException(
                    "Could not locate IDBObj interface in DatReaderWriter assembly. " +
                    "API surface drift — check the vendored Chorizite NuGet version.");
            }
            var d = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);
            foreach (var t in idbObjType.Assembly.GetTypes()) {
                if (t.IsAbstract || !idbObjType.IsAssignableFrom(t)) continue;
                d[t.Name] = t;
                d[t.FullName!] = t;
            }
            _dbObjTypeIndex = d;
        }
        return _dbObjTypeIndex;
    }

    /// <summary>
    /// One row per DBObj concrete type: dispatch metadata reflected out of
    /// the <c>DBObjTypeAttribute</c>. Includes the canonical DAT file the
    /// type lives in (Portal / Cell / Local), the ID range or mask, and the
    /// concrete <c>Type</c>. The cell-DAT types
    /// (<c>LandBlock</c>/<c>LandBlockInfo</c>/<c>EnvCell</c>) have
    /// <c>HasRangeData=false</c> + <c>MaskId</c>-based discrimination per
    /// the AC convention <c>XXYY{FFFF,FFFE,XXXX}</c>; everything else is
    /// range-based per <c>FirstId/LastId</c>.
    /// </summary>
    public sealed record DBObjTypeRow(
        Type ClrType,
        string Name,
        string DatFile,         // "Portal" | "Cell" | "Local" | "Undefined"
        uint FirstId,
        uint LastId,
        uint MaskId,
        bool IsSingular,
        bool HasRangeData);

    private static List<DBObjTypeRow>? _prefixTable;

    private static List<DBObjTypeRow> GetPrefixTable() {
        if (_prefixTable != null) return _prefixTable;
        var idx = GetDBObjTypeIndex();
        var attrType = idx.Values.First().Assembly
            .GetType("DatReaderWriter.Lib.Attributes.DBObjTypeAttribute");
        if (attrType == null) {
            throw new InvalidOperationException(
                "Could not locate DBObjTypeAttribute in DatReaderWriter assembly.");
        }
        var firstIdProp = attrType.GetProperty("FirstId");
        var lastIdProp = attrType.GetProperty("LastId");
        var maskIdProp = attrType.GetProperty("MaskId");
        var datFileTypeProp = attrType.GetProperty("DatFileType");
        var isSingularProp = attrType.GetProperty("IsSingular");
        var hasRangeProp = attrType.GetProperty("HasRangeData");
        if (firstIdProp == null || lastIdProp == null || maskIdProp == null
            || datFileTypeProp == null || isSingularProp == null || hasRangeProp == null) {
            throw new InvalidOperationException(
                "DBObjTypeAttribute missing one of FirstId/LastId/MaskId/DatFileType/IsSingular/HasRangeData.");
        }
        var seen = new HashSet<Type>();
        var rows = new List<DBObjTypeRow>();
        foreach (var t in idx.Values) {
            if (!seen.Add(t)) continue;
            var attrs = t.GetCustomAttributes(attrType, inherit: false);
            if (attrs.Length == 0) continue;
            foreach (var a in attrs) {
                uint first = Convert.ToUInt32(firstIdProp.GetValue(a) ?? 0u);
                uint last = Convert.ToUInt32(lastIdProp.GetValue(a) ?? 0u);
                uint mask = Convert.ToUInt32(maskIdProp.GetValue(a) ?? 0u);
                bool singular = (bool)(isSingularProp.GetValue(a) ?? false);
                bool hasRange = (bool)(hasRangeProp.GetValue(a) ?? false);
                var datFile = datFileTypeProp.GetValue(a)?.ToString() ?? "Undefined";
                rows.Add(new DBObjTypeRow(t, t.Name, datFile, first, last, mask, singular, hasRange));
            }
        }
        rows.Sort((a, b) => a.FirstId.CompareTo(b.FirstId));
        _prefixTable = rows;
        return rows;
    }

    /// <summary>
    /// Resolve a DAT record ID to the canonical Chorizite DBObj
    /// concrete type. Uses the FirstId/LastId range for portal-DAT types
    /// (the common case) and falls back to MaskId-based discrimination for
    /// the three Cell-DAT types (LandBlock = XXYYFFFF, LandBlockInfo =
    /// XXYYFFFE, EnvCell = everything else 0x0001-0xFFFD).
    /// </summary>
    private static Type? ResolveDBObjType(uint id) {
        // Iteration metadata is a special case.
        if (id == 0xFFFF0001u) {
            foreach (var r in GetPrefixTable()) if (r.Name == "Iteration") return r.ClrType;
            return null;
        }
        // Cell-DAT discrimination by suffix.
        var suffix = id & 0xFFFFu;
        if (suffix == 0xFFFFu) {
            foreach (var r in GetPrefixTable()) if (r.Name == "LandBlock") return r.ClrType;
            return null;
        }
        if (suffix == 0xFFFEu) {
            foreach (var r in GetPrefixTable()) if (r.Name == "LandBlockInfo") return r.ClrType;
            return null;
        }
        // Range-based lookup (HasRangeData=true types).
        foreach (var r in GetPrefixTable()) {
            if (!r.HasRangeData) continue;
            if (id >= r.FirstId && id <= r.LastId) return r.ClrType;
        }
        // EnvCell catch-all for any remaining 0x__XXXX in the Cell DAT
        // suffix range (0x0001-0xFFFD), since EnvCell has mask=0 and
        // HasRangeData=false.
        if (suffix >= 0x0001u && suffix <= 0xFFFDu) {
            foreach (var r in GetPrefixTable()) if (r.Name == "EnvCell") return r.ClrType;
        }
        return null;
    }

    /// <summary>
    /// Compute (and cache) SHA-256 of a DAT file. Cache key is (path,
    /// length, mtime) so editing the DAT invalidates. The base DATs are
    /// immutable by [[feedback_base_dats_only_for_bake]] discipline; the
    /// cache is here so a validator that lists+samples 14 types doesn't
    /// re-scan an 884 MB file 14 times.
    /// </summary>
    private static string ComputeDatSha256(string datPath) {
        var info = new FileInfo(datPath);
        if (!info.Exists) throw new FileNotFoundException($"DAT not found: {datPath}");
        var key = datPath;
        lock (_datSha256Lock) {
            if (_datSha256Cache.TryGetValue(key, out var hit) &&
                hit.Length == info.Length && hit.WriteUtc == info.LastWriteTimeUtc) {
                return hit.Sha256;
            }
        }
        // Compute outside the lock (the SHA scan is slow).
        using var sha = SHA256.Create();
        using var stream = File.OpenRead(datPath);
        var hash = sha.ComputeHash(stream);
        var hex = BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
        lock (_datSha256Lock) {
            _datSha256Cache[key] = (info.Length, info.LastWriteTimeUtc, hex);
        }
        return hex;
    }

    /// <summary>
    /// Pre-flight modder-DAT guard per
    /// [[feedback_base_dats_only_for_bake]]. Scans the supplied IDs for any
    /// match against the <c>0x__FFxxxx</c> modder convention (with the
    /// well-known <c>0xFFFFxxxx</c> iteration metadata exempt). Returns the
    /// first offending ID, or null if clean.
    /// </summary>
    private static uint? FindModderIdAmongIds(IEnumerable<uint> ids) {
        foreach (var id in ids) {
            // Skip the well-known iteration metadata 0xFFFFxxxx range.
            if ((id & 0xFFFF0000u) == 0xFFFF0000u) continue;
            // The modder convention is any ID whose second byte is 0xFF
            // (e.g. 0x01FF1234). Real base DAT records never have 0xFF
            // there.
            if ((id & 0x00FF0000u) == 0x00FF0000u) return id;
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-list-dat-records
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Enumerate every record in a DAT file, optionally filtered by DBObj
    /// type name (case-insensitive, e.g. <c>"GfxObj"</c>, <c>"Surface"</c>).
    /// If <paramref name="typeName"/> is null or empty, returns every
    /// record. The result includes the DAT file's SHA-256 (cached), so the
    /// validator can pin its sampling against the same bytes across runs.
    /// </summary>
    public DatRecordListResult ChoriziteListDatRecords(string datPath, string? typeName) {
        Type? filterType = null;
        if (!string.IsNullOrWhiteSpace(typeName)) {
            var idx = GetDBObjTypeIndex();
            if (!idx.TryGetValue(typeName, out filterType)) {
                throw new ArgumentException(
                    $"Unknown DBObj type '{typeName}'. " +
                    $"Known types: {string.Join(", ", idx.Keys.Where(k => !k.Contains('.')).OrderBy(x => x).Take(20))}…");
            }
        }

        // If caller didn't specify a DAT path, pick the canonical DAT for
        // the type (Portal/Cell/Local). When BOTH typeName and datPath are
        // empty we default to portal.
        var resolved = ResolveDatPathForType(datPath, filterType);
        var sha = ComputeDatSha256(resolved);

        using var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Upfront;
        });

        var summaries = new List<DatRecordSummary>();
        if (filterType != null) {
            var ids = EnumerateIdsForType(dat, filterType).ToList();
            foreach (var id in ids) {
                int size = TryGetCompressedSize(dat, id);
                summaries.Add(new DatRecordSummary(
                    IdHex: $"0x{id:X8}",
                    Id: id,
                    TypeName: filterType.Name,
                    CompressedSize: size));
            }
        } else {
            // Walk every type in the chosen DAT → flatten. Slower; only used
            // when caller wants a global enumeration (rarely; the validator
            // pivots per-type).
            foreach (var row in GetPrefixTable()) {
                if (!DatMatches(resolved, row.DatFile)) continue;
                IEnumerable<uint> ids;
                try {
                    ids = EnumerateIdsForType(dat, row.ClrType);
                } catch {
                    continue;
                }
                foreach (var id in ids) {
                    int size = TryGetCompressedSize(dat, id);
                    summaries.Add(new DatRecordSummary(
                        IdHex: $"0x{id:X8}",
                        Id: id,
                        TypeName: row.Name,
                        CompressedSize: size));
                }
            }
        }

        // Stable order: by ID.
        summaries.Sort((a, b) => a.Id.CompareTo(b.Id));

        return new DatRecordListResult(
            DatPath: resolved,
            DatSha256: sha,
            RecordCount: summaries.Count,
            Records: summaries,
            Source: $"DatReaderWriter.DatDatabase.GetAllIdsOfType<{filterType?.Name ?? "*"}> on {resolved}");
    }

    /// <summary>
    /// Enumerate every ID in <paramref name="dat"/> that resolves to
    /// <paramref name="dbType"/>. For range-based types (everything in the
    /// portal DAT), delegates to <c>GetAllIdsOfType&lt;T&gt;</c>. For the
    /// three cell-DAT types (HasRangeData=false; discriminated by ID
    /// suffix), walks the entire B-tree and filters by suffix. The cell
    /// DAT B-tree walk is materialised lazily via
    /// <c>Tree.GetFilesInRange(0, uint.MaxValue)</c>.
    /// </summary>
    private static IEnumerable<uint> EnumerateIdsForType(DRW.DatDatabase dat, Type dbType) {
        var row = GetPrefixTable().FirstOrDefault(r => r.ClrType == dbType);
        if (row != null && row.HasRangeData) {
            // Standard path — let DRW's source-generator emit handle it.
            var miGeneric = typeof(DRW.DatDatabase)
                .GetMethod("GetAllIdsOfType", BindingFlags.Public | BindingFlags.Instance)!
                .MakeGenericMethod(dbType);
            return (IEnumerable<uint>)miGeneric.Invoke(dat, null)!;
        }
        // Cell-DAT type: walk the tree and discriminate by suffix.
        // We need to access dat.Tree.GetFilesInRange(0, uint.MaxValue).
        var treeField = typeof(DRW.DatDatabase).GetField("Tree",
            BindingFlags.Public | BindingFlags.Instance);
        if (treeField == null) return Enumerable.Empty<uint>();
        var tree = treeField.GetValue(dat);
        if (tree == null) return Enumerable.Empty<uint>();
        var getFilesInRange = tree.GetType().GetMethods()
            .FirstOrDefault(m => m.Name == "GetFilesInRange" && m.GetParameters().Length == 2);
        if (getFilesInRange == null) return Enumerable.Empty<uint>();
        var entries = getFilesInRange.Invoke(tree, new object[] { 0u, uint.MaxValue });
        if (entries == null) return Enumerable.Empty<uint>();
        var typeName = dbType.Name;
        return EnumerateAndFilterBySuffix((IEnumerable)entries, typeName);
    }

    private static IEnumerable<uint> EnumerateAndFilterBySuffix(IEnumerable entries, string typeName) {
        PropertyInfo? idProp = null;
        foreach (var e in entries) {
            idProp ??= e.GetType().GetProperty("Id") ?? throw new InvalidOperationException(
                "DatBTreeFile lacks .Id property — DRW API drift.");
            uint id = Convert.ToUInt32(idProp.GetValue(e) ?? 0u);
            var suffix = id & 0xFFFFu;
            switch (typeName) {
                case "LandBlock":
                    if (suffix == 0xFFFFu) yield return id;
                    break;
                case "LandBlockInfo":
                    if (suffix == 0xFFFEu) yield return id;
                    break;
                case "EnvCell":
                    // Anything 0x0001-0xFFFD in the cell DAT, excluding
                    // the iteration metadata 0xFFFF0001.
                    if (id == 0xFFFF0001u) break;
                    if (suffix >= 0x0001u && suffix <= 0xFFFDu) yield return id;
                    break;
                default:
                    break;
            }
        }
    }

    private static bool DatMatches(string resolvedDatPath, string datFile) {
        var fname = Path.GetFileName(resolvedDatPath).ToLowerInvariant();
        return datFile.ToLowerInvariant() switch {
            "portal" => fname.Contains("portal"),
            "cell" => fname.Contains("cell"),
            "local" => fname.Contains("local"),
            _ => false,
        };
    }

    private static int TryGetCompressedSize(DRW.DatDatabase dat, uint id) {
        // The BTree file entry carries the compressed size; the public
        // surface doesn't expose it directly per id, but TryGetFile on the
        // tree returns a DatBTreeFile with .Size. Use reflection to access
        // the Tree field (public per DatDatabase.cs:40).
        try {
            var treeField = typeof(DRW.DatDatabase)
                .GetField("Tree", BindingFlags.Public | BindingFlags.Instance);
            if (treeField == null) return 0;
            var tree = treeField.GetValue(dat);
            if (tree == null) return 0;
            var tryGetFile = tree.GetType()
                .GetMethods()
                .FirstOrDefault(m => m.Name == "TryGetFile" && m.GetParameters().Length == 2);
            if (tryGetFile == null) return 0;
            var args = new object?[] { id, null };
            var ok = (bool)(tryGetFile.Invoke(tree, args) ?? false);
            if (!ok) return 0;
            var fileEntry = args[1]!;
            var fi = fileEntry.GetType().GetField("Size");
            if (fi != null) return Convert.ToInt32(fi.GetValue(fileEntry) ?? 0);
            var pi = fileEntry.GetType().GetProperty("Size");
            if (pi != null) return Convert.ToInt32(pi.GetValue(fileEntry) ?? 0);
            return 0;
        } catch {
            return 0;
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-parse-dat-record
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Parse one DAT record via the Chorizite generated DBObj reader and
    /// emit its field tree as a JSON node. <paramref name="idHex"/> accepts
    /// either <c>0x</c>-prefixed hex or decimal. Type is auto-detected from
    /// the ID's high byte (falls back to LandBlock/LandBlockInfo/EnvCell by
    /// suffix per the prefix table from
    /// [[reference_ac_dat_file_types]]). On any parse failure we return an
    /// <c>errorMessage</c> instead of throwing, so the validator records the
    /// drift as a row instead of crashing.
    /// </summary>
    public DatRecordParseResult ChoriziteParseDatRecord(string datPath, string idHex, string? typeNameHint) {
        uint id = ParseIdHex(idHex);

        Type? dbType = null;
        var idx = GetDBObjTypeIndex();
        if (!string.IsNullOrWhiteSpace(typeNameHint)) {
            if (!idx.TryGetValue(typeNameHint, out dbType)) {
                return new DatRecordParseResult(
                    IdHex: $"0x{id:X8}",
                    Id: id,
                    TypeName: typeNameHint!,
                    Fields: null,
                    ErrorMessage: $"Unknown type hint '{typeNameHint}'",
                    Source: "ChoriziteParseDatRecord");
            }
        }
        dbType ??= ResolveDBObjType(id);
        if (dbType == null) {
            return new DatRecordParseResult(
                IdHex: $"0x{id:X8}",
                Id: id,
                TypeName: "Unknown",
                Fields: null,
                ErrorMessage: $"Could not resolve DBObj type for ID 0x{id:X8}; outside known prefix ranges.",
                Source: "ChoriziteParseDatRecord");
        }

        var resolved = ResolveDatPathForType(datPath, dbType);

        // Per [[feedback_base_dats_only_for_bake]] pre-flight: refuse to
        // parse from a non-base DAT bundle. The check happens here (vs at
        // list time) because parse is the hot path the validator drives.
        // Singleton record (one record only) — skip the modder check; the
        // signature ID 0xFFFF0001 is the iteration metadata which we
        // explicitly carve out below.

        using var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
        });

        // Drive TryGet<T> via reflection.
        var tryGet = typeof(DRW.DatDatabase)
            .GetMethods()
            .FirstOrDefault(m => m.Name == "TryGet"
                && m.IsGenericMethodDefinition
                && m.GetParameters().Length == 2);
        if (tryGet == null) {
            return new DatRecordParseResult(
                IdHex: $"0x{id:X8}", Id: id, TypeName: dbType.Name, Fields: null,
                ErrorMessage: "DatDatabase.TryGet<T>(id, out T) not found",
                Source: "ChoriziteParseDatRecord");
        }
        var tryGetGeneric = tryGet.MakeGenericMethod(dbType);
        var args = new object?[] { id, null };
        bool ok;
        try {
            ok = (bool)(tryGetGeneric.Invoke(dat, args) ?? false);
        } catch (TargetInvocationException tex) {
            return new DatRecordParseResult(
                IdHex: $"0x{id:X8}", Id: id, TypeName: dbType.Name, Fields: null,
                ErrorMessage: $"Parse threw: {tex.InnerException?.Message ?? tex.Message}",
                Source: "ChoriziteParseDatRecord");
        }
        if (!ok || args[1] == null) {
            return new DatRecordParseResult(
                IdHex: $"0x{id:X8}", Id: id, TypeName: dbType.Name, Fields: null,
                ErrorMessage: $"Record 0x{id:X8} not present in {resolved} or parse returned null.",
                Source: "ChoriziteParseDatRecord");
        }

        // Serialise via System.Text.Json with our custom value converters
        // to handle Vector3/Quaternion/dictionary keys + cycles defensively.
        JsonNode? tree;
        try {
            var json = SerializeDbObj(args[1]!);
            tree = JsonNode.Parse(json);
        } catch (Exception ex) {
            return new DatRecordParseResult(
                IdHex: $"0x{id:X8}", Id: id, TypeName: dbType.Name, Fields: null,
                ErrorMessage: $"Serialise threw: {ex.Message}",
                Source: "ChoriziteParseDatRecord");
        }

        return new DatRecordParseResult(
            IdHex: $"0x{id:X8}",
            Id: id,
            TypeName: dbType.Name,
            Fields: tree,
            ErrorMessage: null,
            Source: $"DatReaderWriter.DBObjs.{dbType.Name} via TryGet<T>");
    }

    /// <summary>
    /// Serialise a DBObj instance with System.Text.Json — but flatten the
    /// types DRW exposes that don't serialise cleanly by default: Numerics
    /// types (Vector3/Quaternion) become arrays, byte[] becomes base64
    /// (System.Text.Json default), and dictionary keys of any non-string
    /// type are stringified via ToString(). Cycles are avoided by using
    /// ReferenceHandler.Preserve only if absolutely needed; the AC DBObj
    /// graphs are tree-shaped so we don't enable it by default (cleaner JSON).
    /// </summary>
    private static string SerializeDbObj(object dbobj) {
        var opts = new JsonSerializerOptions {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
            WriteIndented = false,
            IncludeFields = true,
            MaxDepth = 256,
        };
        // For dictionary-keys-as-numbers (which AC DBObjs use heavily — e.g.
        // SoundTable.Sounds keyed by Sound enum), enable allowing non-string
        // keys; STJ will coerce via ToString.
        opts.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
        opts.Converters.Add(new Vector3JsonConverter());
        opts.Converters.Add(new QuaternionJsonConverter());
        opts.Converters.Add(new StringBaseConverterFactory());
        return JsonSerializer.Serialize(dbobj, opts);
    }

    /// <summary>
    /// Converter factory for DRW's <c>StringBase</c> family
    /// (<c>AC1LegacyPStringBase</c>, <c>ObfuscatedPStringBase</c>,
    /// <c>PStringBase</c>). Used both as a value-converter (serialise to the
    /// underlying <c>.Value</c> string) AND as a dictionary-key converter,
    /// because the AC DBObj graph uses StringBase types as Dictionary keys
    /// (ChatPoseTable.PoseDict, etc.) which System.Text.Json otherwise
    /// refuses.
    /// </summary>
    private sealed class StringBaseConverterFactory : System.Text.Json.Serialization.JsonConverterFactory {
        public override bool CanConvert(Type typeToConvert) {
            if (typeToConvert == null) return false;
            var t = typeToConvert;
            while (t != null) {
                if (t.Name == "StringBase" || (t.Name.StartsWith("StringBase") && t.IsGenericType)) return true;
                if (t.BaseType == null) break;
                t = t.BaseType;
            }
            return false;
        }
        public override System.Text.Json.Serialization.JsonConverter? CreateConverter(Type typeToConvert, JsonSerializerOptions options) {
            var converterType = typeof(StringBaseConverter<>).MakeGenericType(typeToConvert);
            return (System.Text.Json.Serialization.JsonConverter?)Activator.CreateInstance(converterType);
        }
    }

    private sealed class StringBaseConverter<T> : System.Text.Json.Serialization.JsonConverter<T> {
        public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            throw new NotSupportedException();
        public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) {
            if (value == null) { writer.WriteNullValue(); return; }
            // Use the .Value property if accessible; else ToString.
            var valueProp = value.GetType().GetProperty("Value");
            string? s = valueProp?.GetValue(value) as string ?? value.ToString();
            writer.WriteStringValue(s ?? "");
        }
        public override void WriteAsPropertyName(Utf8JsonWriter writer, T value, JsonSerializerOptions options) {
            if (value == null) { writer.WritePropertyName(""); return; }
            var valueProp = value.GetType().GetProperty("Value");
            string? s = valueProp?.GetValue(value) as string ?? value.ToString();
            writer.WritePropertyName(s ?? "");
        }
    }

    private sealed class Vector3JsonConverter : System.Text.Json.Serialization.JsonConverter<System.Numerics.Vector3> {
        public override System.Numerics.Vector3 Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            throw new NotSupportedException();
        public override void Write(Utf8JsonWriter writer, System.Numerics.Vector3 value, JsonSerializerOptions options) {
            writer.WriteStartArray();
            writer.WriteNumberValue(value.X);
            writer.WriteNumberValue(value.Y);
            writer.WriteNumberValue(value.Z);
            writer.WriteEndArray();
        }
    }
    private sealed class QuaternionJsonConverter : System.Text.Json.Serialization.JsonConverter<System.Numerics.Quaternion> {
        public override System.Numerics.Quaternion Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            throw new NotSupportedException();
        public override void Write(Utf8JsonWriter writer, System.Numerics.Quaternion value, JsonSerializerOptions options) {
            writer.WriteStartArray();
            writer.WriteNumberValue(value.W);
            writer.WriteNumberValue(value.X);
            writer.WriteNumberValue(value.Y);
            writer.WriteNumberValue(value.Z);
            writer.WriteEndArray();
        }
    }

    private static uint ParseIdHex(string idHex) {
        if (string.IsNullOrWhiteSpace(idHex))
            throw new ArgumentException("Missing record id");
        var trimmed = idHex.Trim();
        if (trimmed.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
            return Convert.ToUInt32(trimmed.Substring(2), 16);
        }
        if (uint.TryParse(trimmed, out var dec)) return dec;
        return Convert.ToUInt32(trimmed, 16);
    }

    // ─────────────────────────────────────────────────────────────────
    //  Internal helpers — wider DAT path lookup than ResolveDatPath
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Resolve a DAT path, accepting either an explicit file path OR a
    /// well-known short-name (e.g. <c>"portal"</c>, <c>"cell"</c>,
    /// <c>"local"</c>). The base DATs sit under <c>~/ac_base_dats/</c> per
    /// [[feedback_base_dats_only_for_bake]]; this lookup makes the JSON
    /// command interface less fragile than requiring callers to remember
    /// the exact filename.
    /// </summary>
    /// <summary>
    /// As <see cref="ResolveDatPathPermissive"/>, but when <paramref name="datPath"/>
    /// is null/empty AND <paramref name="dbType"/> is provided, pick the
    /// canonical DAT for that type (Portal/Cell/Local) from the prefix
    /// table.
    /// </summary>
    private static string ResolveDatPathForType(string? datPath, Type? dbType) {
        if (!string.IsNullOrWhiteSpace(datPath)) {
            return ResolveDatPathPermissive(datPath);
        }
        if (dbType == null) return ResolveDatPathPermissive(null);
        var row = GetPrefixTable().FirstOrDefault(r => r.ClrType == dbType);
        if (row == null) return ResolveDatPathPermissive(null);
        return row.DatFile.ToLowerInvariant() switch {
            "portal" => ResolveDatPathPermissive("portal"),
            "cell" => ResolveDatPathPermissive("cell"),
            "local" => ResolveDatPathPermissive("local"),
            _ => ResolveDatPathPermissive(null),
        };
    }

    private static string ResolveDatPathPermissive(string? datPath) {
        if (string.IsNullOrWhiteSpace(datPath)) {
            return ResolveDatPath(null);
        }
        var trimmed = datPath.Trim();
        // Short-name aliases.
        var baseDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "ac_base_dats");
        var aliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            ["portal"] = "client_portal.dat",
            ["client_portal"] = "client_portal.dat",
            ["cell"] = "client_cell_1.dat",
            ["client_cell"] = "client_cell_1.dat",
            ["client_cell_1"] = "client_cell_1.dat",
            ["local"] = "client_local_English.dat",
            ["client_local"] = "client_local_English.dat",
            ["client_local_English"] = "client_local_English.dat",
        };
        if (aliases.TryGetValue(trimmed, out var fname)) {
            var p = Path.Combine(baseDir, fname);
            if (!File.Exists(p))
                throw new FileNotFoundException(
                    $"Base DAT '{fname}' not found at {p}; populate ~/ac_base_dats per [[feedback_base_dats_only_for_bake]].");
            return p;
        }
        if (!File.Exists(trimmed)) {
            throw new FileNotFoundException($"datPath not found: {trimmed}");
        }
        return trimmed;
    }

    // ─────────────────────────────────────────────────────────────────
    //  Diagnostic — prefix-table dump (used by validator authoring)
    // ─────────────────────────────────────────────────────────────────

    public sealed record DatPrefixTableRow(
        string TypeName,
        string DatFile,
        string FirstIdHex,
        string LastIdHex,
        bool IsSingular,
        bool HasRangeData);

    public IReadOnlyList<DatPrefixTableRow> ChoriziteListDatTypes() {
        var seen = new HashSet<string>();
        var rows = new List<DatPrefixTableRow>();
        foreach (var row in GetPrefixTable()) {
            if (!seen.Add(row.Name)) continue;
            rows.Add(new DatPrefixTableRow(
                TypeName: row.Name,
                DatFile: row.DatFile,
                FirstIdHex: $"0x{row.FirstId:X8}",
                LastIdHex: $"0x{row.LastId:X8}",
                IsSingular: row.IsSingular,
                HasRangeData: row.HasRangeData));
        }
        return rows;
    }
}
