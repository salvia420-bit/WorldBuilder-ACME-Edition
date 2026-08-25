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

        /// <summary>
        /// Who is filing these reports. Stamped into every queued entry's <c>author</c> field,
        /// and the key the panel's "my reports" list filters on.
        ///
        /// This used to be read from the stock <c>AC</c> plugin (<c>ACPlugin.Game.AccountName</c>).
        /// That plugin is no longer a dependency: it takes over the retail client's own UI —
        /// it registers its own CharSelect and DatPatch screens and claims the client's
        /// `Indicators` root element (external/chorizite/ACPlugin/ACPlugin.cs:78-93,104-110) —
        /// which is far too much to inherit for one string. Set it with the in-game
        /// <c>/redline author &lt;name&gt;</c> command, or here.
        ///
        /// Defaults to "unknown", which is what the pipeline schema sees when nobody sets it
        /// (schema_v1.json requires author minLength 1, so it can never be blank).
        /// </summary>
        [JsonPropertyName("author")]
        public string Author { get; set; } = "unknown";

        /// <summary>
        /// MASTER on/off for the whole tool. When false the plugin stays loaded but is inert:
        /// no picking, no overlay, no D3D device hooks, no panel. This is what the panel's
        /// title-bar switch and <c>/redline on|off</c> write, and it round-trips through
        /// <c>ISerializeSettings</c>, so the choice survives a client restart.
        ///
        /// Turning it back on does NOT require the panel — <c>/redline on</c> works with no
        /// RmlUi installed at all, so disabling the tool can never strand a user.
        /// </summary>
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
