namespace WorldBuilder.Shared.Lib.AceDb;

/// <summary>
/// Per-weenie creature roster row, joined from <c>weenie</c> +
/// <c>weenie_properties_int</c>(CreatureType) +
/// <c>weenie_properties_string</c>(Name).
/// Surface-level snapshot for the static-site overlay and
/// <c>compare-creatures-to-retail</c>; richer detail (stats, attacks)
/// lives in <see cref="AceCreatureSnapshot"/>.
/// </summary>
public sealed record CreatureRecord(
    int Wcid,
    string ClassName,
    string DisplayName,
    int? CreatureType,
    int? Level);

/// <summary>
/// Per-weenie NPC roster row. Same join as <see cref="CreatureRecord"/>
/// but pre-filtered by WeenieType (Vendor=20, Creature with talk
/// interaction=4) plus a Title property when present.
/// </summary>
public sealed record NpcRecord(
    int Wcid,
    string ClassName,
    string DisplayName,
    int WeenieType,
    string? Title);

/// <summary>
/// Housing index row sourced from <c>house_portal</c>. The ACE
/// world dump in this repo carries housing entirely as portal
/// destinations (no separate <c>house</c> / <c>house_list</c> tables);
/// each portal's <c>obj_Cell_Id</c> + position locates the housing
/// entry on the world map.
/// </summary>
public sealed record HouseRecord(
    uint HouseId,
    uint ObjCellId,
    float OriginX,
    float OriginY,
    float OriginZ);
