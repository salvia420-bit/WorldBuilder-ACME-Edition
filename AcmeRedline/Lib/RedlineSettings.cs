using System.Text.Json.Serialization;

namespace AcmeRedline.Lib {
    /// <summary>
    /// Persisted plugin settings. Round-tripped by Chorizite through
    /// <c>ISerializeSettings&lt;T&gt;</c>
    /// (external/chorizite/Chorizite/Chorizite.Core/Plugins/AssemblyLoader/ISerializeSettings.cs).
    /// </summary>
    public class RedlineSettings {
        /// <summary>
        /// Where redline.jsonl / redline-status.jsonl / shots/ live.
        /// Empty (the default) means "next to the plugin" - resolved at runtime to
        /// <c>IPluginCore.DataDirectory</c>/redline, i.e.
        /// &lt;IPluginManager.StorageDirectory&gt;/AcmeRedline/redline.
        /// </summary>
        [JsonPropertyName("queueDir")]
        public string QueueDir { get; set; } = "";

        /// <summary>Absolute path to the acme-meta.json sidecar. Empty => probe the dat directory.</summary>
        [JsonPropertyName("kitMetaPath")]
        public string KitMetaPath { get; set; } = "";

        /// <summary>Draw the selection/hover overlay.</summary>
        [JsonPropertyName("overlayEnabled")]
        public bool OverlayEnabled { get; set; } = true;

        /// <summary>Tint previously-annotated targets by their pipeline status.</summary>
        [JsonPropertyName("statusOverlayEnabled")]
        public bool StatusOverlayEnabled { get; set; } = false;

        /// <summary>
        /// Enable the world-space highlight, which works by hooking the client's IDirect3DDevice9
        /// vtable (see <see cref="AcmeRedline.Services.DeviceHooks"/>). Separate from
        /// <see cref="OverlayEnabled"/> on purpose: the 2D HUD is harmless, whereas the vtable
        /// hooks touch the render pipeline and a user chasing a graphics problem should be able to
        /// turn just those off without losing picking.
        /// </summary>
        [JsonPropertyName("worldHighlightEnabled")]
        public bool WorldHighlightEnabled { get; set; } = true;

        /// <summary>Default severity pre-selected in the panel.</summary>
        [JsonPropertyName("defaultSeverity")]
        public int DefaultSeverity { get; set; } = 2;

        /// <summary>
        /// Dat Font id (0x40......) for the overlay HUD text. 0 = pick the first Font record in
        /// the portal dat. IFontManager.GetFont(string,int) is not an option; see
        /// OverlayRenderer.HudFont for why.
        /// </summary>
        [JsonPropertyName("hudFontDid")]
        public uint HudFontDid { get; set; } = 0;
    }
}
