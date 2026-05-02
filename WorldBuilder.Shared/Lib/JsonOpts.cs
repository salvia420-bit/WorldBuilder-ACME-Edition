using System.Text.Json;

namespace WorldBuilder.Shared.Lib;

/// <summary>
/// Shared <see cref="JsonSerializerOptions"/> instances for the most-duplicated configurations
/// across the codebase. <see cref="JsonSerializerOptions"/> is expensive to construct on first use
/// (reflection caches, naming-policy compilation) so reusing one frozen instance per config
/// is materially cheaper than allocating fresh options per call — especially in bulk export
/// loops that serialize thousands of small objects.
///
/// IMPORTANT: <see cref="JsonSerializerOptions"/> becomes read-only after its first use by
/// <see cref="JsonSerializer"/>. Treat these instances as IMMUTABLE — do NOT add converters,
/// mutate properties, or otherwise modify them at runtime. If you need a one-off variant,
/// construct via the copy constructor: <c>new JsonSerializerOptions(JsonOpts.Indented) { ... }</c>.
/// </summary>
public static class JsonOpts {
    /// <summary>
    /// Case-insensitive deserialization. Used by every command that loads JSON config files
    /// (creature/spell/weenie/worldgen/layout pipelines) where the source schema may use any
    /// casing convention.
    /// </summary>
    public static readonly JsonSerializerOptions CaseInsensitive = new() {
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>
    /// Indented serialization for human-readable output (reports, manifests, dump-style commands).
    /// </summary>
    public static readonly JsonSerializerOptions Indented = new() {
        WriteIndented = true,
    };

    /// <summary>
    /// CamelCase + indented — the standard "report file" shape (ontology dumps, atlas manifests,
    /// pattern analyses). CamelCase keys keep the JSON friendly to JS/TS frontends.
    /// </summary>
    public static readonly JsonSerializerOptions CamelCaseIndented = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    /// <summary>
    /// CamelCase + compact + drop-nulls — used for streaming NDJSON-style output where each
    /// record is a single line and absent fields shouldn't bloat the file. Hot path: per-LB
    /// query/describe loops can emit tens of thousands of records.
    /// </summary>
    public static readonly JsonSerializerOptions CamelCaseCompactIgnoreNull = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };
}
