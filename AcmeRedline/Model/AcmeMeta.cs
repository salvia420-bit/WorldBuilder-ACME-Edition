using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AcmeRedline.Model {
    /// <summary>
    /// The optional <c>acme-meta.json</c> sidecar shipped next to the dats by the
    /// ACME kit builder. Absent on a vanilla install - every consumer must tolerate null.
    ///
    /// Two jobs:
    ///   (a) stamp every queue entry with the exact release the reporter is running,
    ///       so the pipeline can reproduce what the reporter saw;
    ///   (b) let the plugin warn at capture time when a selection lands on a surface
    ///       that the kit treats as special (terrain-protected, or palette-routed).
    /// </summary>
    public class AcmeMeta {
        /// <summary>Release tag, e.g. "acme-r9".</summary>
        [JsonPropertyName("kitTag")]
        public string? KitTag { get; set; }

        /// <summary>SHA-256 of client_portal.dat as shipped.</summary>
        [JsonPropertyName("portalSha256")]
        public string? PortalSha256 { get; set; }

        /// <summary>SHA-256 of client_highres.dat as shipped.</summary>
        [JsonPropertyName("highresSha256")]
        public string? HighresSha256 { get; set; }

        /// <summary>
        /// RenderSurface ids (hex strings, e.g. "0x0600ABCD") that the kit considers
        /// terrain-protected: repainting them changes the landscape atlas and is not a
        /// safe per-object fix. Selecting one raises <see cref="Guards.TerrainProtected"/>.
        /// </summary>
        [JsonPropertyName("terrainProtectedRs")]
        public List<string> TerrainProtectedRs { get; set; } = [];

        /// <summary>
        /// RenderSurface ids (hex strings) that are reached through a palette/PalShift
        /// route, so their on-screen colour is not the colour in the dat record.
        /// Selecting one raises <see cref="Guards.PaletteRoute"/>.
        /// </summary>
        [JsonPropertyName("paletteRouteRs")]
        public List<string> PaletteRouteRs { get; set; } = [];
    }
}
