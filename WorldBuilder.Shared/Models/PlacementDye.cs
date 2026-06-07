using MemoryPack;

namespace WorldBuilder.Shared.Models {
    /// <summary>
    /// Addressable per-instance dye enrichment for a placement.
    ///
    /// Models the two DISTINCT ACE dye representations without conflating them
    /// (see SPEC §3.1):
    /// <list type="bullet">
    /// <item><b>PRIMARY — true addressable remap:</b> <see cref="SubPaletteId"/> is a Palette
    /// DID (<c>0x04xxxxxx</c>) plus <see cref="Offset"/>/<see cref="Length"/>, mirroring
    /// ACE <c>weenie_properties_palette</c> (<c>WeeniePropertiesPalette.cs:21-25</c>).</item>
    /// <item><b>SECONDARY — template tint:</b> <see cref="PaletteTemplate"/>
    /// (<c>PropertyInt.PaletteTemplate(3)</c>, a small enum index — NEVER a DID) plus
    /// <see cref="Shade"/> (<c>PropertyFloat.Shade(12)</c>).</item>
    /// </list>
    ///
    /// A placement MAY carry a SubPalette remap, a (PaletteTemplate, Shade) tint, or both.
    /// Do NOT store dye as a single <c>(uint PaletteId, float Shade)</c> pretending
    /// <c>PaletteId</c> is a DID — that is the generator/template path and violates
    /// addressability.
    /// </summary>
    [MemoryPackable]
    public sealed partial class PlacementDye {
        /// <summary>
        /// Palette DID (<c>0x04xxxxxx</c>) — the true addressable remap. Null when this dye
        /// carries only a template tint. Maps to <c>weenie_properties_palette.sub_Palette_Id</c>.
        /// </summary>
        public uint? SubPaletteId { get; set; }

        /// <summary>Maps to <c>weenie_properties_palette.offset</c>.</summary>
        public ushort Offset { get; set; }

        /// <summary>Maps to <c>weenie_properties_palette.length</c>.</summary>
        public ushort Length { get; set; }

        /// <summary>
        /// Template tint index — <c>PropertyInt.PaletteTemplate(3)</c>. A SMALL enum index
        /// (~0..70), NOT a DID. Emitted as a <c>weenie_properties_int</c> row (type=3).
        /// </summary>
        public int? PaletteTemplate { get; set; }

        /// <summary>
        /// Shade — <c>PropertyFloat.Shade(12)</c>, in <c>[0,1]</c> or null. Emitted as a
        /// <c>weenie_properties_float</c> row (type=12).
        /// </summary>
        public float? Shade { get; set; }
    }
}
