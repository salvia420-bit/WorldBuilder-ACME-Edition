using System.Text.Json.Serialization;

namespace AcmeLights.Lib {
    /// <summary>Chorizite-persisted settings (the live knobs are in C:\Temp\acdt\lights.cfg —
    /// see <see cref="LightsConfig"/>; this only gates whether the plugin arms at all).</summary>
    public class LightsSettings {
        public bool Enabled { get; set; } = true;
    }

    [JsonSourceGenerationOptions(WriteIndented = true)]
    [JsonSerializable(typeof(LightsSettings))]
    public partial class LightsJsonContext : JsonSerializerContext {
    }
}
