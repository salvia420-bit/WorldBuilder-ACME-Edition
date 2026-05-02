namespace WorldBuilder.Shared.Lib.AceDb;

/// <summary>
/// Canonical record for a player-visible weenie spawn. Sourced from either
/// the LSD-Partial spawnMap dump or the ACE world DB's
/// <c>landblock_instance</c> table. Distinct from
/// <see cref="LandblockInstanceRecord"/> (which mirrors the raw DB row);
/// SpawnRecord is the higher-level, ontology-aware view the static-site
/// emitter, render pipeline, and per-LB describer all share.
/// </summary>
/// <param name="Wcid">Weenie class ID (DAT or ACE custom; custom ≥ 100 000).</param>
/// <param name="Name">Weenie display name (best-effort from source).</param>
/// <param name="Category">
/// Render-time category dispatch: "Creature" | "Npc" | "Object" | "Surface".
/// Resolved at gazetteer-build time so the renderer doesn't re-derive it
/// per tile.
/// </param>
/// <param name="Generator">
/// Spawn provenance hint: "Static" | "Linkable" | "Respawn" | "Unknown".
/// LSD source maps from the placement-system field; ACE source maps from
/// generator type or "Static" for direct landblock_instance rows.
/// </param>
/// <param name="LandblockId">
/// Owning landblock key (high byte = lbX, low byte = lbY). Lets a single
/// SpawnRecord round-trip through indexes that don't carry the parent key.
/// </param>
/// <param name="Cell">ACE cell number within the landblock (0 for outdoor).</param>
/// <param name="WeenieType">Optional ACE WeenieType enum value for downstream tooling.</param>
/// <param name="AcpediaTitle">Wiki page title when matched (HIGH/MED tier).</param>
/// <param name="AcpediaTier">Match tier: HIGH | MED | LOW | NONE | null.</param>
/// <param name="IsSynthetic">
/// True when reconstructed from incomplete data (e.g. ACE row without a
/// weenie join, or position guessed from cell center). The frontend renders
/// synthetic records with a "?" overlay so guesses don't masquerade as facts.
/// </param>
public sealed record SpawnRecord(
    int Wcid,
    string Name,
    string Category,
    string Generator,
    ushort LandblockId,
    int Cell,
    float X,
    float Y,
    float Z,
    int? WeenieType,
    string? AcpediaTitle,
    string? AcpediaTier,
    bool IsSynthetic);
