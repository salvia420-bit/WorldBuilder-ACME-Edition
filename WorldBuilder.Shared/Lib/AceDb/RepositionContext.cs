using System.Collections.Generic;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// Per-building Z shift produced by the placement pipeline. Applied to
    /// every weenie whose <c>obj_Cell_Id</c> falls inside <see cref="OldCellIds"/>
    /// (interior cells of the building). This is how an indoor NPC follows its
    /// building when the building's origin Z changed (terrain edit, ML
    /// placement, etc.) and avoids the "NPC on the roof" failure mode.
    /// </summary>
    public class BuildingDelta {
        /// <summary>Landblock the building lives in (after placement).</summary>
        public required ushort LandblockId { get; init; }

        /// <summary>
        /// Interior EnvCell numbers (0x0100–0xFFFD) belonging to the building.
        /// Combined with LandblockId to form full obj_Cell_Id values.
        /// </summary>
        public required IReadOnlyCollection<ushort> OldCellIds { get; init; }

        /// <summary>The Z shift applied to the building (newOriginZ - oldOriginZ).</summary>
        public required float DeltaZ { get; init; }
    }

    /// <summary>
    /// All the data the reposition service needs from the export pipeline.
    /// </summary>
    public class RepositionContext {
        /// <summary>
        /// Landblock IDs whose terrain was modified during this export.
        /// </summary>
        public required IReadOnlyCollection<ushort> ModifiedLandblocks { get; init; }

        /// <summary>
        /// Old (pre-edit) terrain entries per landblock, keyed by landblock ID.
        /// Each array has 81 entries (9x9 vertex grid).
        /// </summary>
        public required Dictionary<ushort, TerrainEntry[]> OldTerrain { get; init; }

        /// <summary>
        /// New (post-edit, composited) terrain entries per landblock.
        /// </summary>
        public required Dictionary<ushort, TerrainEntry[]> NewTerrain { get; init; }

        /// <summary>
        /// The LandHeightTable from Region.LandDefs, used to convert height indices to world Z.
        /// </summary>
        public required float[] LandHeightTable { get; init; }

        /// <summary>
        /// Directory where the SQL file will be written.
        /// </summary>
        public required string ExportDirectory { get; init; }

        /// <summary>
        /// Optional per-building Z deltas. When supplied, indoor weenies
        /// (cell ID ≥ 0x0100) in the listed cells get their origin_Z shifted
        /// by the building's delta, which keeps NPCs aligned with the
        /// building's floor instead of the terrain underneath.
        /// </summary>
        public IReadOnlyCollection<BuildingDelta>? IndoorBuildingDeltas { get; init; }
    }
}
