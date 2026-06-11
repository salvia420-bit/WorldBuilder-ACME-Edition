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
        // F166: default orientation is the IDENTITY quaternion (w=1, x=y=z=0), NOT (w=0, z=1) which
        // is a 180° rotation about +Z — that flip spawns every default-angle placement facing
        // backwards in ACE. JSON-migration note: pre-F166 projects persisted AnglesZ=1/AnglesW=0 for
        // default-angle placements; those rows will keep their stored (flipped) values on reload —
        // re-add or re-set the angles to pick up identity.
        public float AnglesW { get; set; } = 1f;
        public float AnglesX { get; set; }
        public float AnglesY { get; set; }
        public float AnglesZ { get; set; }

        /// <summary>
        /// E1 (wave-2) PR3 — optional placement guid (the Option B / per-placement addressable key,
        /// <c>landblock_instance.guid == biota.id</c>). Null for fresh placements; minted in the
        /// static range (<see cref="WorldBuilder.Shared.Lib.AceDb.StaticGuidAllocator"/>) at export
        /// time when a per-placement biota override is emitted. Additive — default null preserves the
        /// existing landblock_instance SQL path (the emitter still auto-generates a guid when 0).
        /// </summary>
        public uint? Guid { get; set; }

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

        /// <summary>
        /// E1 (wave-2) PR3 — per-placement export TARGET (SPEC §3.4). <see cref="EnrichmentScope.ClassDefault"/>
        /// (the default) routes enrichment to the WORLD <c>weenie_properties_*</c> tables keyed by wcid;
        /// <see cref="EnrichmentScope.PlacementOverride"/> routes it to the SHARD <c>biota_properties_*</c>
        /// tables keyed by the placement <see cref="Guid"/> (Option B). Additive — default ClassDefault
        /// preserves the PR1/PR2 world-only behavior.
        /// </summary>
        public EnrichmentScope Scope { get; set; } = EnrichmentScope.ClassDefault;

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
