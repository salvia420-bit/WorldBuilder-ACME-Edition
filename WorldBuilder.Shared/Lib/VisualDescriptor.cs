using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace WorldBuilder.Shared.Lib;

// ─────────────────────────────────────────────────────────────────────────────
//  Visual-Behavior Suite — descriptor + archetype-rule schema (Phase 0 / commit 2)
//
//  This is the C# side of the suite the shipped tree-wind (archetype #1,
//  trunk-canopy) generalizes into. A descriptor maps a SetupDID → an archetype
//  (a named bundle of render-only visual-behavior components). The classifier
//  (CommandEngine.Vfx.cs) emits `visual_descriptors.jsonl`; the registry
//  (`visual_archetype_rules.jsonl`) is the single source of truth for archetype
//  ids + their default component bundles.
//
//  LEGACY-SAFETY (build-spec §1.2): a descriptor carries ONLY component-id
//  STRINGS + sparse config. It never holds a server-replicated field, never a
//  wire value. The component id is the contract the JS runtime (scene3d/vfx/*)
//  keys on — e.g. "deformation.windBend" MUST match windBend.js byte-for-byte.
//
//  Spec refs: §3.3 (schema), §3.4 (file-name + JsonObject-config adjudication),
//  §12.2 (command surface). The design doc used the `procMotion.*` family; the
//  build-spec §2.2 family enum is {deformation|weathering|emissive|texture|
//  particle}, so motion components live under `deformation.*` (the same
//  adjudication already applied to the shipped windBend component).
// ─────────────────────────────────────────────────────────────────────────────

/// <summary>
/// One resolved visual-behavior component on a descriptor. Carries its id (the
/// JS-runtime contract key), the §14 conflict <see cref="Channel"/> a single
/// driver may own, an optional sparse config override (resolved against the
/// archetype-rule defaults at load), and the §14 suppression flag.
/// <para>
/// <see cref="Config"/> is a <see cref="JsonObject"/> so the config schema can
/// evolve without a model bump (build-spec §3.4).
/// </para>
/// </summary>
public sealed record VisualComponentRef {
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("channel")] public string? Channel { get; init; }
    [JsonPropertyName("config")] public JsonObject? Config { get; init; }
    [JsonPropertyName("suppressedBy")] public string? SuppressedBy { get; init; }
}

/// <summary>
/// One classifier feature/signal that contributed to a descriptor. Audit-only;
/// stripped from the <c>--slim</c> client catalog (build-spec §3.3).
/// </summary>
public sealed record VisualSignal {
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("value")] public string? Value { get; init; }
    [JsonPropertyName("weight")] public double Weight { get; init; }
}

/// <summary>
/// Records the DAT channels a SetupModel's <c>default_animation</c> already
/// drives (build-spec §14). The suite must never add a component on a channel
/// the DAT already owns. Empty/default for the common frozen-scenery case.
/// </summary>
public sealed record DatSelfAnim {
    [JsonPropertyName("animDid")] public uint AnimDid { get; init; }
    [JsonPropertyName("hooks")] public int[] Hooks { get; init; } = Array.Empty<int>();
    [JsonPropertyName("channels")] public string[] Channels { get; init; } = Array.Empty<string>();
    [JsonPropertyName("hasKeyframeMotion")] public bool HasKeyframeMotion { get; init; }
}

/// <summary>
/// One classified DID's visual-behavior descriptor (one line of
/// <c>visual_descriptors.jsonl</c>). Keyed by SetupDID (serialized "0x%08X" for
/// git-diff audit). Build-spec §3.3.
/// </summary>
public sealed record VisualDescriptor {
    /// <summary>The SetupDID this descriptor classifies (serialized as "0x%08X").</summary>
    [JsonPropertyName("did")]
    [JsonConverter(typeof(HexDidJsonConverter))]
    public uint Did { get; init; }

    /// <summary>The selected archetype id — MUST be a key in the rule registry.</summary>
    [JsonPropertyName("archetype")] public string Archetype { get; init; } = VisualArchetypeIds.Rigid;

    /// <summary>Classifier confidence ∈ [0,1] (build-spec §4.6).</summary>
    [JsonPropertyName("confidence")] public double Confidence { get; init; } = 1.0;

    /// <summary>
    /// How this descriptor was produced: classifier | classifier-low | manual |
    /// dat-self-label | allowlist (build-spec §3.3).
    /// </summary>
    [JsonPropertyName("source")] public string Source { get; init; } = "classifier";

    /// <summary>Mechanism dispatch hint for the primary motion (A|B|frag|light|particle|defer).</summary>
    [JsonPropertyName("mech")] public string? Mech { get; init; }

    /// <summary>The resolved component bundle (selector + additive refiners).</summary>
    [JsonPropertyName("components")] public List<VisualComponentRef> Components { get; init; } = new();

    /// <summary>Universal modifiers (weatherable, textured) that compose on the base archetype.</summary>
    [JsonPropertyName("modifiers")] public List<string> Modifiers { get; init; } = new();

    /// <summary>DAT-self-animation channels owned by the model's default_animation (§14).</summary>
    [JsonPropertyName("datSelfAnim")] public DatSelfAnim? DatSelfAnim { get; init; }

    /// <summary>Audit signals (stripped from the --slim client catalog).</summary>
    [JsonPropertyName("signals")] public List<VisualSignal> Signals { get; init; } = new();
}

/// <summary>
/// One archetype-rule registry line (<c>visual_archetype_rules.jsonl</c>) — the
/// single source of truth for archetype ids + their default component bundles +
/// the classifier selector. Build-spec §3.3/§4.7.
/// </summary>
public sealed record VisualArchetypeRule {
    /// <summary>Stable kebab-case archetype id (build-spec §3.1).</summary>
    [JsonPropertyName("id")] public string Id { get; init; } = "";

    /// <summary>Human-readable label.</summary>
    [JsonPropertyName("label")] public string? Label { get; init; }

    /// <summary>Component ids this archetype carries (the JS-runtime contract keys).</summary>
    [JsonPropertyName("components")] public List<string> Components { get; init; } = new();

    /// <summary>Mechanism: A|B|frag|light|particle|defer (build-spec §3.2).</summary>
    [JsonPropertyName("mech")] public string? Mech { get; init; }

    /// <summary>Cost class: free|cheap|medium|expensive.</summary>
    [JsonPropertyName("cost")] public string? Cost { get; init; }

    /// <summary>URL flag that toggles this archetype's runtime (e.g. "treeWind").</summary>
    [JsonPropertyName("flag")] public string? Flag { get; init; }

    /// <summary>Per-component default config, keyed by component id (build-spec §3.4 resolveConfig).</summary>
    [JsonPropertyName("defaults")] public JsonObject? Defaults { get; init; }

    /// <summary>The classifier selection rule (predicate + Phase-0 seed dids), build-spec §4.7.</summary>
    [JsonPropertyName("select")] public VisualArchetypeSelect? Select { get; init; }
}

/// <summary>
/// The classifier selection rule for an archetype. A <see cref="Dids"/> seed set
/// (Phase-0 explicit allowlist, e.g. trunk-canopy reproduces the JS
/// <c>TREE_WIND_DIDS</c> by construction) and/or a <see cref="Predicate"/>
/// (weenie-prop / geometry test, matured later). Build-spec §4.4/§4.7.
/// </summary>
public sealed record VisualArchetypeSelect {
    /// <summary>Cascade tier (−1 manual … 5 default); lower runs first (build-spec §4.3).</summary>
    [JsonPropertyName("tier")] public int Tier { get; init; }

    /// <summary>The base confidence this rule assigns when it fires (build-spec §4.6).</summary>
    [JsonPropertyName("confidence")] public double Confidence { get; init; } = 1.0;

    /// <summary>
    /// Explicit Phase-0 seed DID set (serialized "0x%08X"). When present,
    /// `emit-allowlist &lt;id&gt;` returns exactly this set — the round-trip seed.
    /// </summary>
    [JsonPropertyName("dids")]
    [JsonConverter(typeof(HexDidArrayJsonConverter))]
    public uint[]? Dids { get; init; }

    /// <summary>WeaponType ints this rule matches (build-spec §4.4), null when N/A.</summary>
    [JsonPropertyName("weaponTypes")] public int[]? WeaponTypes { get; init; }

    /// <summary>ItemType BITFIELD flags this rule matches — a DID fires when its
    /// (OR-merged) ItemType has ANY of these bits set (e.g. Gem=2048). null when N/A.</summary>
    [JsonPropertyName("itemTypes")] public int[]? ItemTypes { get; init; }

    /// <summary>MaterialType ints that REFINE (never select) this rule (build-spec §4.5).</summary>
    [JsonPropertyName("materialTypes")] public int[]? MaterialTypes { get; init; }

    /// <summary>Free-form predicate id documenting the geometry/prop test (audit).</summary>
    [JsonPropertyName("predicate")] public string? Predicate { get; init; }
}

/// <summary>
/// Generated const-string archetype ids (build-spec §3.1: open-set kebab strings,
/// NOT a closed enum). C# references ids through these consts; the authoritative
/// list is <c>visual_archetype_rules.jsonl</c>. The <c>vfx gen-ids</c> verb
/// regenerates this set from the rule registry (Phase-0 carries the commit-2
/// subset by hand).
/// </summary>
public static class VisualArchetypeIds {
    public const string TrunkCanopy = "trunk-canopy";
    public const string RigidGlint  = "rigid-glint";
    public const string TipFlex     = "tip-flex";
    public const string Rigid       = "rigid";
    // Phase-3 particle/aura archetypes. gem-sparkle lands with the P3.5 slice
    // (COMMIT 4); brazier/creature-breath/foliage-* register with P3.6/P3.7. The
    // rule is forward-declared in visual_archetype_rules.jsonl but NOT yet wired
    // into the VfxClassify cascade (no FindRule(GemSparkle)), so it classifies
    // nothing yet — gauge stays all-zero (gauge-safe; agent-14 deferred predicate).
    public const string GemSparkle     = "gem-sparkle";
    public const string Brazier        = "brazier";
    public const string CreatureBreath = "creature-breath";
    public const string FoliagePollen  = "foliage-pollen";
    public const string FoliageLeaves  = "foliage-leaves";

    /// <summary>The archetype set, in cascade-tier order (Phase-1 + Phase-3 particle).</summary>
    public static readonly string[] All = {
        GemSparkle, RigidGlint, TipFlex,            // tier 1
        TrunkCanopy, Brazier, CreatureBreath,       // tier 2
        FoliagePollen, FoliageLeaves,               // tier 3
        Rigid,                                      // tier 5
    };
}

/// <summary>
/// In-memory DID → <see cref="VisualDescriptor"/> map. Structural twin of
/// <see cref="WeenieIndex"/> (build-spec §3.4) with JSONL save/load. Keeps the
/// visual layer independently regenerable from the ontology + weenie index.
/// </summary>
public sealed class VisualDescriptorIndex {
    private readonly Dictionary<uint, VisualDescriptor> _byDid;

    public static VisualDescriptorIndex Empty { get; } = new(new Dictionary<uint, VisualDescriptor>());

    public VisualDescriptorIndex(Dictionary<uint, VisualDescriptor> byDid) {
        _byDid = byDid ?? throw new ArgumentNullException(nameof(byDid));
    }

    public int Count => _byDid.Count;

    public VisualDescriptor? Get(uint did) =>
        _byDid.TryGetValue(did, out var d) ? d : null;

    public bool TryGet(uint did, out VisualDescriptor descriptor) =>
        _byDid.TryGetValue(did, out descriptor!);

    public IEnumerable<VisualDescriptor> Entries => _byDid.Values;

    /// <summary>Add or replace a descriptor (last writer wins, like the weenie index re-ingest).</summary>
    public void Upsert(VisualDescriptor descriptor) => _byDid[descriptor.Did] = descriptor;

    // Camel-case, null-ignoring — matches WeenieIndex.JsonOpts (build-spec §3.4).
    // The hex-DID converters live on the model via [JsonConverter] attributes.
    private static readonly JsonSerializerOptions JsonOpts = new() {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    /// <summary>Serialize as JSONL, one descriptor per line, ordered by DID.</summary>
    public int SaveJsonl(string outputPath) {
        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        int count = 0;
        using var w = new StreamWriter(outputPath, false, System.Text.Encoding.UTF8);
        foreach (var d in _byDid.Values.OrderBy(e => e.Did)) {
            w.WriteLine(JsonSerializer.Serialize(d, JsonOpts));
            count++;
        }
        return count;
    }

    /// <summary>
    /// Load a JSONL produced by <see cref="SaveJsonl"/>. Throws
    /// <see cref="FileNotFoundException"/> when the file is missing — callers
    /// handle the absent-file case explicitly (mirrors <see cref="WeenieIndex.LoadJsonl"/>).
    /// </summary>
    public static VisualDescriptorIndex LoadJsonl(string inputPath) {
        if (!File.Exists(inputPath))
            throw new FileNotFoundException($"VisualDescriptor JSONL not found: {inputPath}");

        var dict = new Dictionary<uint, VisualDescriptor>();
        foreach (var line in File.ReadLines(inputPath)) {
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            var entry = JsonSerializer.Deserialize<VisualDescriptor>(trimmed, JsonOpts);
            if (entry == null) continue;
            dict[entry.Did] = entry;
        }
        return new VisualDescriptorIndex(dict);
    }
}

/// <summary>
/// Serializes a <see cref="uint"/> DID as the "0x%08X" string the rest of the
/// suite (and git-diff audits) expect; parses hex or bare-decimal on read,
/// matching the <c>ParseDid</c> convention (CommandEngine.SurfaceMaterials.cs).
/// </summary>
public sealed class HexDidJsonConverter : JsonConverter<uint> {
    public static uint ParseDid(string s) {
        s = s.Trim();
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            return uint.Parse(s.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return uint.Parse(s, NumberStyles.Integer, CultureInfo.InvariantCulture);
    }

    public override uint Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) {
        if (reader.TokenType == JsonTokenType.String)
            return ParseDid(reader.GetString() ?? "0");
        if (reader.TokenType == JsonTokenType.Number)
            return reader.GetUInt32();
        throw new JsonException($"Cannot parse DID from token {reader.TokenType}.");
    }

    public override void Write(Utf8JsonWriter writer, uint value, JsonSerializerOptions options) =>
        writer.WriteStringValue($"0x{value:X8}");
}

/// <summary>Array variant of <see cref="HexDidJsonConverter"/> for the seed DID sets.</summary>
public sealed class HexDidArrayJsonConverter : JsonConverter<uint[]> {
    public override uint[] Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) {
        if (reader.TokenType != JsonTokenType.StartArray)
            throw new JsonException("Expected a DID array.");
        var list = new List<uint>();
        while (reader.Read()) {
            if (reader.TokenType == JsonTokenType.EndArray) break;
            if (reader.TokenType == JsonTokenType.String)
                list.Add(HexDidJsonConverter.ParseDid(reader.GetString() ?? "0"));
            else if (reader.TokenType == JsonTokenType.Number)
                list.Add(reader.GetUInt32());
            else
                throw new JsonException($"Unexpected token {reader.TokenType} in DID array.");
        }
        return list.ToArray();
    }

    public override void Write(Utf8JsonWriter writer, uint[] value, JsonSerializerOptions options) {
        writer.WriteStartArray();
        foreach (var v in value) writer.WriteStringValue($"0x{v:X8}");
        writer.WriteEndArray();
    }
}
