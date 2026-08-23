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

        /// <summary>
        /// When true (default), the CPhysicsObj::DoInterpretedMotion detour arms a ragdoll the
        /// INSTANT the Dead motion begins (ragdoll from the death hit). When false that detour
        /// no-ops its arm and behavior reverts to today's: the canned death animation plays and
        /// the corpse ragdolls when it finishes (MotionDone). The hook itself stays installed
        /// either way; only the arming is gated.
        /// </summary>
        [JsonPropertyName("armOnDeathStart")]
        public bool ArmOnDeathStart { get; set; } = true;

        /// <summary>
        /// Master switch for the LIVE-MOTION layer (hit reactions on living creatures), separate from
        /// the death ragdoll above. When true the plugin subscribes to the two S2C combat signals
        /// (Effects_PlayScriptType / Combat_HandleAttackerNotificationEvent) and runs
        /// <see cref="AcmeRagdoll.Services.LiveMotionRegistry"/> alongside the death registry.
        ///
        /// INVARIANT (runbook C1): false =&gt; bit-identical client behaviour. No network subscription
        /// is made, no LiveMotionRegistry is constructed, and the UpdateParts dispatcher short-
        /// circuits to the death registry only - the live layer contributes nothing to the hot
        /// detour's arm/disarm decision and never touches a part.
        /// </summary>
        [JsonPropertyName("liveMotion")]
        public bool LiveMotion { get; set; } = true;
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
