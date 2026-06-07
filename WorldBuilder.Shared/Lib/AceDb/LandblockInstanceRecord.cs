using System.Collections.Generic;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// Lightweight projection of a row from the ACE ace_world.landblock_instance table.
    /// Includes position and optional rotation (quaternion) for full placement round-trip.
    /// </summary>
    public class LandblockInstanceRecord {
        public uint Guid { get; set; }
        public uint WeenieClassId { get; set; }
        public uint ObjCellId { get; set; }
        public float OriginX { get; set; }
        public float OriginY { get; set; }
        public float OriginZ { get; set; }
        /// <summary>Quaternion W (scalar). Null if angles were not read from DB.</summary>
        public float? AnglesW { get; set; }
        /// <summary>Quaternion X. Null if angles were not read from DB.</summary>
        public float? AnglesX { get; set; }
        /// <summary>Quaternion Y. Null if angles were not read from DB.</summary>
        public float? AnglesY { get; set; }
        /// <summary>Quaternion Z. Null if angles were not read from DB.</summary>
        public float? AnglesZ { get; set; }

        public ushort LandblockId => (ushort)(ObjCellId >> 16);
        public ushort CellId => (ushort)(ObjCellId & 0xFFFF);

        /// <summary>
        /// Outdoor cells are 0x0001-0x0040 (1-64). Interior/dungeon cells start at 0x0100.
        /// </summary>
        public bool IsOutdoor => CellId >= 1 && CellId <= 64;

        /// <summary>
        /// True when this instance is in a dungeon/interior cell (0x0100+).
        /// </summary>
        public bool IsDungeon => CellId >= 0x0100;

        // ── E1 (wave-2) enrichment — additive, default null/empty ───────────
        // Carried downstream from the source placement so future SQL emitters (PR2/PR3) can
        // write weenie_properties_* / biota_properties_*. PR1 does NOT read these in the
        // existing landblock_instance SQL emitter, so the existing SQL output is unchanged.

        /// <summary>Optional addressable dye. Null preserves existing landblock_instance SQL.</summary>
        public PlacementDye? Dye { get; set; }

        /// <summary>Optional generator profiles. Null/empty preserves existing SQL.</summary>
        public List<PlacementGenerator>? Generators { get; set; }

        /// <summary>Optional multi-position map keyed by PositionType enum. Null preserves existing SQL.</summary>
        public Dictionary<PositionType, PlacementPosition>? Positions { get; set; }
    }
}
