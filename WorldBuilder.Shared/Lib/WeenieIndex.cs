using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorldBuilder.Shared.Lib;

/// <summary>
/// Bitfield recording which canonical / annotation sources contributed
/// to a <see cref="WeenieIndexEntry"/>. Renderer + describer consult this
/// when judging trust: AceDb &amp; DatOntology are canonical; LsdSpawnMap
/// is community-curated annotation.
/// </summary>
[Flags]
public enum WeenieSource {
    None        = 0,
    AceDb       = 1 << 0,
    DatOntology = 1 << 1,
    LsdSpawnMap = 1 << 2,
}

/// <summary>
/// Canonical wcid identity record. Sourced from the ACE world DB
/// (<c>weenie</c> + <c>weenie_properties_*</c> joins) and consumed by
/// every render-time path that today reaches into a different store
/// (the <c>OntologyService</c>'s incidental wcid annotations, the
/// per-roster gazetteer JSONs, etc.).
///
/// The shape is intentionally narrow: render handles + identity, no
/// wiki / community / heuristic data. Wiki annotation (Acpedia) is a
/// separate annotation layer the describer reads through a distinct
/// map — never join it into this record.
/// </summary>
public sealed record WeenieIndexEntry(
    // ── Identity (canonical, immutable) ────────────────
    int    Wcid,
    string ClassName,
    int    WeenieType,
    bool   IsServerManaged,
    bool   IsNpc,

    // ── Display (canonical, from property strings) ─────
    string  DisplayName,
    string? Title,

    // ── Render handles (canonical, from property DIDs) ─
    uint?   SetupDid,
    uint?   IconDid,
    uint?   PaletteBaseDid,

    // ── Gameplay attrs (canonical, from property ints) ─
    int?    CreatureType,
    int?    Level,

    // ── Provenance ─────────────────────────────────────
    WeenieSource SourceMask
);

/// <summary>
/// In-memory wcid → identity map. Populated by
/// <c>AceDbConnector.IngestWeenieIndexAsync</c> and persisted as
/// <c>weenie_index.jsonl</c> in the project directory.
///
/// Lookups are O(1). The index is immutable after construction —
/// re-ingest replaces the whole instance.
/// </summary>
public sealed class WeenieIndex {
    private readonly Dictionary<int, WeenieIndexEntry> _byWcid;

    public static WeenieIndex Empty { get; } = new(new Dictionary<int, WeenieIndexEntry>());

    public WeenieIndex(Dictionary<int, WeenieIndexEntry> byWcid) {
        _byWcid = byWcid ?? throw new ArgumentNullException(nameof(byWcid));
    }

    public int Count => _byWcid.Count;

    public WeenieIndexEntry? Get(int wcid) =>
        _byWcid.TryGetValue(wcid, out var e) ? e : null;

    /// <summary>
    /// Fast path for the wcid → setupDid lookup that gates the static-site
    /// renderer's sprite atlas hit. Returns false when the wcid is unknown
    /// or when the weenie has no Setup property in the ACE DB.
    /// </summary>
    public bool TryGetSetup(int wcid, out uint setupDid) {
        if (_byWcid.TryGetValue(wcid, out var e) && e.SetupDid is { } s) {
            setupDid = s;
            return true;
        }
        setupDid = 0;
        return false;
    }

    public IEnumerable<WeenieIndexEntry> Entries => _byWcid.Values;

    public IEnumerable<WeenieIndexEntry> WhereType(int weenieType) =>
        _byWcid.Values.Where(e => e.WeenieType == weenieType);

    public IEnumerable<WeenieIndexEntry> WhereTypeIn(params int[] weenieTypes) {
        var set = new HashSet<int>(weenieTypes);
        return _byWcid.Values.Where(e => set.Contains(e.WeenieType));
    }

    private static readonly JsonSerializerOptions JsonOpts = new() {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    /// <summary>
    /// Serialize as JSONL (one entry per line, ordered by wcid). Returns the
    /// number of entries written. Mirrors the cache-on-disk pattern used by
    /// <c>OntologyService.CacheToFile</c> so consumers can stream-read.
    /// </summary>
    public int SaveJsonl(string outputPath) {
        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        int count = 0;
        using var w = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);
        foreach (var entry in _byWcid.Values.OrderBy(e => e.Wcid)) {
            w.WriteLine(JsonSerializer.Serialize(entry, JsonOpts));
            count++;
        }
        return count;
    }

    /// <summary>
    /// Load a JSONL produced by <see cref="SaveJsonl"/>. Throws
    /// <see cref="FileNotFoundException"/> when the file is missing —
    /// callers handle the absent-file case explicitly (see
    /// <c>CommandEngine.AutoRestoreWeenieIndex</c>).
    /// </summary>
    public static WeenieIndex LoadJsonl(string inputPath) {
        if (!File.Exists(inputPath))
            throw new FileNotFoundException($"WeenieIndex JSONL not found: {inputPath}");

        var dict = new Dictionary<int, WeenieIndexEntry>();
        foreach (var line in File.ReadLines(inputPath)) {
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            var entry = JsonSerializer.Deserialize<WeenieIndexEntry>(trimmed, JsonOpts);
            if (entry == null) continue;
            dict[entry.Wcid] = entry;
        }
        return new WeenieIndex(dict);
    }
}
