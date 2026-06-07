using System.Collections.Generic;
using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Shared.Models {
    /// <summary>
    /// The addressable, round-trippable source-of-truth record for ONE placement, persisted as
    /// a line in <c>placements_enriched.jsonl</c> (SPEC §4).
    ///
    /// Round-trip is JSON ⇄ in-memory placement ⇄ SQL: the JSONL is the SOURCE, the per-table
    /// SQL is GENERATED from it (in PR2/PR3). This record therefore carries BOTH the placement
    /// directive (key + pose, mirroring <c>landblock_instance</c>) AND the enrichment
    /// (<see cref="Dye"/>, <see cref="Generators"/>, <see cref="Positions"/>) plus the
    /// export <see cref="Scope"/>.
    ///
    /// Addressability is preserved exactly: dye stored as <c>SubPaletteId</c> DID (not an index),
    /// generators as named columns (not a blob), positions as a <see cref="PositionType"/>-keyed
    /// map (not array offsets). A serialize → deserialize → serialize cycle is value-exact.
    /// </summary>
    public sealed class EnrichedPlacement {
        // ── Address key (mirrors landblock_instance) ───────────────────────
        /// <summary>"outdoor" or "dungeon" — the source placement collection.</summary>
        public string Kind { get; set; } = "";

        /// <summary>Landblock id (the high 16 bits of obj_Cell_Id).</summary>
        public ushort Landblock { get; set; }

        /// <summary>Cell number (the low 16 bits of obj_Cell_Id).</summary>
        public ushort CellNumber { get; set; }

        /// <summary>Weenie Class Id of the placed object.</summary>
        public uint WeenieClassId { get; set; }

        /// <summary>
        /// Placement guid, when known (Option B / persisted). Null for fresh/unallocated
        /// placements that derive enrichment per-class.
        /// </summary>
        public uint? Guid { get; set; }

        // ── Pose (the placement directive itself) ──────────────────────────
        public float OriginX { get; set; }
        public float OriginY { get; set; }
        public float OriginZ { get; set; }

        public float? AnglesW { get; set; }
        public float? AnglesX { get; set; }
        public float? AnglesY { get; set; }
        public float? AnglesZ { get; set; }

        // ── Enrichment (the E1 payload) ────────────────────────────────────
        public PlacementDye? Dye { get; set; }

        public List<PlacementGenerator>? Generators { get; set; }

        public Dictionary<PositionType, PlacementPosition>? Positions { get; set; }

        /// <summary>Per-class (Option A) vs per-placement (Option B) export target.</summary>
        public EnrichmentScope Scope { get; set; } = EnrichmentScope.ClassDefault;
    }
}
