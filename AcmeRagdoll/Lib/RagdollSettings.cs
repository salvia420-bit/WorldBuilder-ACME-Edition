using System.Text.Json;
using System.Text.Json.Serialization;

namespace AcmeRagdoll.Lib {
    /// <summary>
    /// Persisted plugin settings, round-tripped by Chorizite through
    /// <c>ISerializeSettings&lt;T&gt;</c>
    /// (external/chorizite/Chorizite/Chorizite.Core/Plugins/AssemblyLoader/ISerializeSettings.cs).
    /// </summary>
    public class RagdollSettings {
        /// <summary>Master switch. When false the plugin loads but installs no hooks.</summary>
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; } = true;
    }

    /// <summary>
    /// Source-generated JSON contract for <see cref="RagdollSettings"/>. Source-generated (not
    /// reflection) for the same two reasons AcmeRedline documents: ISerializeSettings needs a
    /// <c>JsonTypeInfo&lt;T&gt;</c>, and a collectible plugin ALC should avoid reflection-emit
    /// serializers that can pin the context.
    /// </summary>
    [JsonSourceGenerationOptions(WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonSerializable(typeof(RagdollSettings))]
    public partial class RagdollJsonContext : JsonSerializerContext {
    }
}
