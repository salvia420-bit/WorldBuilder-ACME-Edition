using System.Collections.Generic;
using System.Numerics;
using System.Text.Json.Serialization;
using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Shared.Models {
    /// <summary>
    /// A generator, item, or portal placement for an outdoor landblock, to be written to
    /// ACE landblock_instance on export. Used by the Terrain editor "ACE Instances" panel.
    /// </summary>
    public class OutdoorInstancePlacement {
        public ushort LandblockId { get; set; }
        public uint WeenieClassId { get; set; }
        /// <summary>Outdoor cell index (typically 1–64).</summary>
        public ushort CellNumber { get; set; }
        public float OriginX { get; set; }
        public float OriginY { get; set; }
        public float OriginZ { get; set; }
        public float AnglesW { get; set; }
        public float AnglesX { get; set; }
        public float AnglesY { get; set; }
        public float AnglesZ { get; set; } = 1f;

        // ── E1 (wave-2) enrichment — additive, default null/empty ───────────
        // These carry per-instance dye / generator / multi-position state through the
        // export round-trip (placements_enriched.jsonl). They default to null so existing
        // placements and the existing landblock_instance SQL path are unaffected (SPEC §3.0).

        /// <summary>Optional addressable dye (SubPaletteId DID + offset/length, and/or template tint).</summary>
        public PlacementDye? Dye { get; set; }

        /// <summary>Optional generator profiles; one SQL row each. Null/empty when not a generator.</summary>
        public List<PlacementGenerator>? Generators { get; set; }

        /// <summary>Optional multi-position map keyed by PositionType enum (never an array offset).</summary>
        public Dictionary<PositionType, PlacementPosition>? Positions { get; set; }

        [JsonIgnore]
        public Vector3 Origin {
            get => new Vector3(OriginX, OriginY, OriginZ);
            set { OriginX = value.X; OriginY = value.Y; OriginZ = value.Z; }
        }

        [JsonIgnore]
        public Quaternion Orientation {
            get => new Quaternion(AnglesX, AnglesY, AnglesZ, AnglesW);
            set { AnglesW = value.W; AnglesX = value.X; AnglesY = value.Y; AnglesZ = value.Z; }
        }
    }
}
