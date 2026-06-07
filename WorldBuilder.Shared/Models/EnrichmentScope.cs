namespace WorldBuilder.Shared.Models {
    /// <summary>
    /// Where a placement's enrichment is exported to (SPEC §3.4). Drives the per-class vs
    /// per-placement target decision in later PRs (PR2 = ClassDefault, PR3 = PlacementOverride).
    /// PR1 only round-trips the value; it changes no SQL behavior.
    /// </summary>
    public enum EnrichmentScope {
        /// <summary>
        /// Option A — emit <c>weenie_properties_*</c> keyed by wcid (world DB). The default.
        /// </summary>
        ClassDefault = 0,

        /// <summary>
        /// Option B — emit a <c>biota</c> stub + <c>biota_properties_*</c> keyed by placement guid
        /// (shard DB).
        /// </summary>
        PlacementOverride = 1
    }
}
