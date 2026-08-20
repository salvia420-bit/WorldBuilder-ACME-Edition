using System.Text.Json;
using System.Text.Json.Serialization;
using AcmeRedline.Model;

namespace AcmeRedline.Lib {
    /// <summary>
    /// Source-generated JSON contracts.
    ///
    /// Two reasons this is source-generated rather than reflection-based:
    ///  - <c>ISerializeSettings&lt;T&gt;.TypeInfo</c> demands a
    ///    <c>System.Text.Json.Serialization.Metadata.JsonTypeInfo&lt;T&gt;</c>, exactly the way
    ///    external/chorizite/ACPlugin/ACPlugin.cs supplies
    ///    <c>SourceGenerationContext.Default.PluginState</c>;
    ///  - plugins are loaded into a collectible AssemblyLoadContext
    ///    (external/chorizite/Chorizite/Chorizite.Core/Plugins/AssemblyLoader/AssemblyPluginLoadContext.cs),
    ///    where reflection-emit-backed serializers are the thing most likely to pin the context.
    /// </summary>
    // WhenWritingNull, NOT Never: schema_v1.json defines selection.triangles / selection.screenLasso
    // (and other optionals) as OBJECTS with no "null" in their type, and is additionalProperties:false
    // throughout — so an absent optional must be OMITTED, never emitted as JSON null (a present null
    // fails validation as "object expected"). Omission also satisfies the schema's anyOf[…, null]
    // scalars (highresSha256, setupId, surfaceId, surfaceTextureId), none of which are "required".
    // Required fields (world.pos, camera.lookAt, clientRelease.kitTag, …) are populated by the live
    // client capture / kit meta, and the plugin blocks submit when they cannot be — see
    // AcmeRedlinePlugin.HandleSubmit — so omission never drops a required value in practice.
    [JsonSourceGenerationOptions(
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonSerializable(typeof(RedlineEntry))]
    [JsonSerializable(typeof(RedlineStatusEvent))]
    [JsonSerializable(typeof(AcmeMeta))]
    [JsonSerializable(typeof(RedlineSettings))]
    public partial class RedlineJsonContext : JsonSerializerContext {
    }

    /// <summary>Convenience wrappers so callers do not have to name the context every time.</summary>
    public static class RedlineJson {
        /// <summary>Serialize one queue entry to a single JSONL line (no trailing newline).</summary>
        public static string ToLine(RedlineEntry entry) =>
            JsonSerializer.Serialize(entry, RedlineJsonContext.Default.RedlineEntry);

        /// <summary>Parse one line of redline-status.jsonl. Returns null on a malformed line.</summary>
        public static RedlineStatusEvent? StatusFromLine(string line) {
            try {
                return JsonSerializer.Deserialize(line, RedlineJsonContext.Default.RedlineStatusEvent);
            }
            catch (JsonException) {
                return null;
            }
        }

        /// <summary>Parse an acme-meta.json sidecar. Returns null on a malformed file.</summary>
        public static AcmeMeta? MetaFromJson(string json) {
            try {
                return JsonSerializer.Deserialize(json, RedlineJsonContext.Default.AcmeMeta);
            }
            catch (JsonException) {
                return null;
            }
        }
    }
}
