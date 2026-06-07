using MemoryPack;

namespace WorldBuilder.Shared.Models {
    /// <summary>
    /// One Position value (the 8-tuple) for a placement's multi-position map. Maps to one row
    /// of ACE <c>weenie_properties_position</c> / <c>biota_properties_position</c>
    /// (<c>WeeniePropertiesPosition.cs:24-40</c>).
    ///
    /// Uses the DB field names (<c>Origin*</c> / <c>Angles*</c>) to match the SQL WB emits;
    /// the runtime ACE entity (<c>PropertiesPosition</c>) calls these <c>Position*</c> /
    /// <c>Rotation*</c> — same values, different names (SPEC §3.3).
    ///
    /// The owning placement keys these by <see cref="WorldBuilder.Shared.Lib.AceDb.PositionType"/>
    /// in a <c>Dictionary</c>, which enforces the ACE <c>UNIQUE(object_Id, position_Type)</c>
    /// constraint in memory — never an array offset.
    /// </summary>
    [MemoryPackable]
    public sealed partial class PlacementPosition {
        public uint ObjCellId { get; set; }

        public float OriginX { get; set; }
        public float OriginY { get; set; }
        public float OriginZ { get; set; }

        public float AnglesW { get; set; }
        public float AnglesX { get; set; }
        public float AnglesY { get; set; }
        public float AnglesZ { get; set; }
    }
}
