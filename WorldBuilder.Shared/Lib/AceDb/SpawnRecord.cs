using System.Numerics;

namespace WorldBuilder.Shared.Lib.AceDb;

/// <summary>
/// Canonical record for a weenie spawn. Sourced from either the LSD-Partial
/// spawnMap dump or the ACE world DB's <c>landblock_instance</c> table.
/// Distinct from <see cref="LandblockInstanceRecord"/> (which mirrors the raw
/// DB row); SpawnRecord is the higher-level, ontology-aware view the
/// static-site emitter, render pipeline, and per-LB describer all share.
/// </summary>
/// <param name="Wcid">Weenie class ID (DAT or ACE custom; custom ≥ 100 000).</param>
/// <param name="Name">Weenie display name (best-effort from source).</param>
/// <param name="Category">
/// Render-time category dispatch: "Creature" | "Npc" | "Object" | "Surface".
/// Resolved at gazetteer-build time so the renderer doesn't re-derive it
/// per tile.
/// </param>
/// <param name="Generator">
/// Spawn provenance hint: "Static" | "Linkable" | "Respawn" | "Encounter" | "Unknown".
/// LSD source maps from the placement-system field; ACE source maps from
/// generator type, "Encounter" for encounter-table fauna, or "Static" for
/// direct landblock_instance rows. The renderer ignores this; the stager
/// drops it (ingest-side provenance + a dedup discriminator).
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
/// <param name="IsServerManaged">
/// True for weenies the ACE server manages directly (doors, chests,
/// generators, statues spawned by generators). Previously these were
/// filtered out at gazetteer-build time, but the renderer needs them to
/// stack server-spawned doors/statues over their DAT-side pedestals — so
/// we keep them here and let the consumer decide whether to draw or hide.
/// </param>
/// <param name="Orientation">
/// World-space rotation. Carried from <c>landblock_instance.angles_*</c>
/// (ACE source) or the LSD JSON when present. Defaults to identity when
/// the source doesn't supply orientation. The renderer uses this to draw
/// directional placements (doors, statues, signs) facing the right way.
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
    bool IsSynthetic,
    bool IsServerManaged = false,
    Quaternion Orientation = default) {

    /// <summary>
    /// <see cref="Orientation"/> falls back to identity when the source
    /// didn't supply one — the record's <c>default</c> Quaternion is
    /// (0,0,0,0), which isn't a valid rotation. Use this accessor on any
    /// render path so a missing source always produces an upright sprite.
    /// </summary>
    public Quaternion OrientationOrIdentity =>
        Orientation == default ? Quaternion.Identity : Orientation;

    /// <summary>
    /// World-space X coordinate. <see cref="X"/> stores the LB-local origin
    /// from <c>landblock_instance.origin_X</c> (or LSD's "x" field), both of
    /// which are in [0, 192). Render-time and frontend-overlay consumers
    /// need world coords (0..49152), computed by adding the parent LB's
    /// world origin. Without this accessor, treating <see cref="X"/> as
    /// world silently drops every spawn outside the rendered window's
    /// bounds-check (the bug that hid every NPC from the static-site tile
    /// pyramid prior to 2026-05).
    /// </summary>
    public float WorldX => ((LandblockId >> 8) & 0xFF) * 192f + X;

    /// <summary>World-space Y coordinate; see <see cref="WorldX"/>.</summary>
    public float WorldY => (LandblockId & 0xFF) * 192f + Y;

    /// <summary>
    /// Orientation quaternion components, emitted as flat scalars (qw/qx/qy/qz)
    /// so the per-LB stager (stage-ring-spawns.py) and any non-.NET consumer can
    /// read rotation without a Quaternion deserializer. Required because
    /// <see cref="System.Numerics.Quaternion"/> serializes only its
    /// <c>IsIdentity</c> property under System.Text.Json (W/X/Y/Z are fields, not
    /// properties), so <see cref="Orientation"/> alone drops the rotation on the
    /// wire — the 2026-06 orientation regression. Falls back to identity (Qw=1)
    /// when the source supplied no orientation. See
    /// docs/per-landblock-faithful-world-method-2026-06-26.md Fix 2.
    /// </summary>
    public float Qw => OrientationOrIdentity.W;
    /// <inheritdoc cref="Qw"/>
    public float Qx => OrientationOrIdentity.X;
    /// <inheritdoc cref="Qw"/>
    public float Qy => OrientationOrIdentity.Y;
    /// <inheritdoc cref="Qw"/>
    public float Qz => OrientationOrIdentity.Z;
}
