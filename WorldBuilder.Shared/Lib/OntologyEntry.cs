using System.Numerics;

namespace WorldBuilder.Shared.Lib;

/// <summary>
/// A single entry in the enriched ontology — one per Setup or GfxObj.
/// Contains auto-classified tags derived from DAT geometry data.
/// </summary>
public class OntologyEntry {
    /// <summary>DAT file ID (e.g. 0x02001A3F for Setup, 0x01000AEC for GfxObj).</summary>
    public uint ObjectId { get; set; }

    /// <summary>"Setup" or "GfxObj".</summary>
    public string DatType { get; set; } = "";

    /// <summary>Bounding box minimum corner in local space.</summary>
    public Vector3 BoundsMin { get; set; }

    /// <summary>Bounding box maximum corner in local space.</summary>
    public Vector3 BoundsMax { get; set; }

    /// <summary>Maximum dimension of the bounding box (max of X, Y, Z extents).</summary>
    public float MaxDimension { get; set; }

    /// <summary>Number of GfxObj parts (for Setup objects). 0 for standalone GfxObj.</summary>
    public int PartCount { get; set; }

    /// <summary>Total polygon count across all parts.</summary>
    public int PolyCount { get; set; }

    /// <summary>Height / max(width, depth) ratio — tall/thin objects have high aspect ratio.</summary>
    public float AspectRatio { get; set; }

    /// <summary>Auto-classified scale: Tiny, Small, Medium, Large, Massive.</summary>
    public string Scale { get; set; } = "Unknown";

    /// <summary>Auto-classified category: Structure, Scenery, Furniture, Prop, Creature, etc.</summary>
    public string Category { get; set; } = "Unknown";

    /// <summary>How this entry was classified: "Building", "Scenery", "Heuristic", "Manual".</summary>
    public string ClassificationSource { get; set; } = "Heuristic";

    /// <summary>Combined keyword tags for search (e.g. ["tree", "large", "scenery"]).</summary>
    public string[] Tags { get; set; } = Array.Empty<string>();

    /// <summary>Total vertex count across all parts.</summary>
    public int VertexCount { get; set; }

    /// <summary>Surface (texture) IDs used by this model, as hex strings.</summary>
    public List<string>? SurfaceIds { get; set; }

    /// <summary>Relative path to the thumbnail PNG in the catalog output directory.</summary>
    public string? ThumbnailPath { get; set; }

    /// <summary>Human-readable name (from string tables or curated data).</summary>
    public string? Name { get; set; }

    /// <summary>Material tags derived from texture analysis (e.g. "stone", "wood", "metal").</summary>
    public string[]? MaterialTags { get; set; }

    /// <summary>Weenie Class ID from LSD data (maps game logic to this model).</summary>
    public int? WeenieClassId { get; set; }

    /// <summary>Weenie Type enumeration (1=Generic, 7=Creature, 12=Vendor, etc.).</summary>
    public int? WeenieType { get; set; }

    /// <summary>Creature level from weenie data.</summary>
    public int? Level { get; set; }

    /// <summary>Creature type/family enumeration from weenie data.</summary>
    public int? CreatureType { get; set; }

    /// <summary>Difficulty tier derived from level: Starter/Low/Medium/Hard/Elite/Legendary.</summary>
    public string? DifficultyTier { get; set; }

    /// <summary>Cultural architecture: Aluvian, Sho, Gharu'ndim, Viamontian, Empyrean, or Neutral.</summary>
    public string? Architecture { get; set; }

    /// <summary>Biome affinity list (e.g. ["Temperate", "Swamp"]). Intrinsic to the object, not retail-derived.</summary>
    public string[]? Biome { get; set; }

    /// <summary>Behavior pattern: Melee, Caster, Mixed, Passive, Boss.</summary>
    public string? Behavior { get; set; }

    /// <summary>Creature family name from CreatureType enum (e.g. "drudge", "olthoi").</summary>
    public string? CreatureFamilyName { get; set; }
}

/// <summary>
/// Summary report from an ontology scan.
/// </summary>
public class OntologyScanReport {
    public int TotalSetups { get; set; }
    public int TotalGfxObjs { get; set; }
    public int ClassifiedAsBuilding { get; set; }
    public int ClassifiedAsScenery { get; set; }
    public int ClassifiedAsFurniture { get; set; }
    public int ClassifiedAsProp { get; set; }
    public int ClassifiedAsUnknown { get; set; }
    public int TotalEntries { get; set; }
    public double ScanTimeMs { get; set; }

    /// <summary>Breakdown of how many entries per category.</summary>
    public Dictionary<string, int> CategoryCounts { get; set; } = new();

    /// <summary>Breakdown of how many entries per scale.</summary>
    public Dictionary<string, int> ScaleCounts { get; set; } = new();
}
