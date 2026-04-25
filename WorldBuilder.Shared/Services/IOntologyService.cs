namespace WorldBuilder.Shared.Services;

/// <summary>
/// Scans DAT files to build a complete ontology of all placeable objects
/// (Setup, GfxObj), auto-classifying them by size, type, and usage.
/// Bridges the "Ontology Gap" between the ~80 hand-curated entries and
/// the ~15,000+ models available in the DAT files.
/// </summary>
public interface IOntologyService {

    /// <summary>
    /// Scans all Setup and GfxObj entries from portal.dat, computes geometry
    /// features, and classifies each entry using heuristics plus cross-
    /// referencing with BuildingBlueprintCache and Scene objects.
    /// </summary>
    /// <param name="dats">The loaded DatReaderWriter instance.</param>
    /// <param name="scanGfxObjs">If true, also scans standalone GfxObj IDs (0x01). Default: true.</param>
    /// <returns>Scan results with classification statistics.</returns>
    Lib.OntologyScanReport Scan(Lib.IDatReaderWriter dats, bool scanGfxObjs = true);

    /// <summary>
    /// Gets the ontology entry for a specific object ID.
    /// Returns null if the ID was not found in the last scan.
    /// </summary>
    Lib.OntologyEntry? GetEntry(uint objectId);

    /// <summary>
    /// Searches the ontology by category, scale, or tag keyword.
    /// All parameters are optional — omitted parameters match everything.
    /// </summary>
    IEnumerable<Lib.OntologyEntry> Search(
        string? category = null,
        string? scale = null,
        string? keyword = null,
        int limit = 100);

    /// <summary>
    /// Returns the total number of entries in the current ontology.
    /// </summary>
    int Count { get; }

    /// <summary>
    /// Whether a scan has been completed at least once.
    /// </summary>
    bool IsScanned { get; }

    /// <summary>
    /// Returns the complete category → count breakdown.
    /// </summary>
    Dictionary<string, int> GetCategoryCounts();

    /// <summary>
    /// Returns the complete scale → count breakdown.
    /// </summary>
    Dictionary<string, int> GetScaleCounts();

    /// <summary>
    /// Returns all entries in the ontology index. For CSV/bulk export.
    /// </summary>
    IEnumerable<Lib.OntologyEntry> GetAllEntries();

    /// <summary>
    /// Imports catalog metadata (thumbnail paths, vertex counts, surface IDs)
    /// into matching ontology entries. Returns the number of entries enriched.
    /// </summary>
    int ImportCatalog(string indexJsonPath);

    /// <summary>
    /// Cross-references string table entries with ontology entries to assign
    /// human-readable names and keyword-based category/tag assignments.
    /// Returns the number of entries enriched.
    /// </summary>
    int EnrichFromStrings(List<(uint Hash, string Text, string TableType)> strings);

    /// <summary>
    /// Analyzes surface/texture IDs per model and classifies materials
    /// (fire, stone, wood, metal, etc.) via keyword heuristics on texture IDs.
    /// Returns the number of entries enriched.
    /// </summary>
    int EnrichMaterials(Lib.IDatReaderWriter dats);

    /// <summary>
    /// Enriches ontology entries with weenie data (names, types, levels, creature families).
    /// The weenie summary file should be produced by the ingest-weenies command.
    /// Returns the number of entries enriched.
    /// </summary>
    int EnrichFromWeenies(string weenieSummaryPath);

    /// <summary>
    /// Enriches ontology entries from the canonical enrichment JSON produced by
    /// build_ontology_enrichment.py. Applies architecture, biome, behavior,
    /// creature family, and difficulty tier tags. Matches by setupDid → ObjectId.
    /// Returns the number of entries enriched.
    /// </summary>
    int EnrichFromCanonical(string canonicalJsonPath);

    /// <summary>
    /// Enriches ontology entries from the unified ontology JSON produced by
    /// scripts/build_unified_ontology.py. Applies the full ontology stack
    /// (canonical + ACE world DB + Setup→Parts inheritance + DAT building/
    /// scenery signals + geometry classification) in one pass, keyed by both
    /// setup_did and gfx_obj_id. Returns the number of entries enriched.
    /// </summary>
    int EnrichFromUnified(string unifiedOntologyJsonPath);
}
