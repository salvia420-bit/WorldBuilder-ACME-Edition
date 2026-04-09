using System.Collections.Generic;

namespace WorldBuilder.Shared.Lib.AceDb {

    /// <summary>One row from <c>weenie_properties_texture_map</c>.</summary>
    public sealed class AceTextureMapRow {
        public byte Index { get; set; }
        public uint OldId { get; set; }
        public uint NewId { get; set; }
        /// <summary>Optional label used in SQL comments (e.g. "Tail", "Horn").</summary>
        public string Comment { get; set; } = "";
    }

    /// <summary>One row from <c>weenie_properties_anim_part</c>.</summary>
    public sealed class AceAnimPartRow {
        public byte Index { get; set; }
        public uint AnimationId { get; set; }
        /// <summary>Optional label used in SQL comments (e.g. "Invisible tail").</summary>
        public string Comment { get; set; } = "";
    }

    /// <summary>
    /// Combined texture-map and anim-part overrides for one weenie object.
    /// Corresponds to the rows in <c>weenie_properties_texture_map</c> and
    /// <c>weenie_properties_anim_part</c> for a single <c>object_Id</c>.
    /// </summary>
    public sealed class AceCreatureOverrides {
        public uint ObjectId { get; set; }
        public List<AceTextureMapRow> TextureMap { get; } = new();
        public List<AceAnimPartRow> AnimParts { get; } = new();
    }
}
