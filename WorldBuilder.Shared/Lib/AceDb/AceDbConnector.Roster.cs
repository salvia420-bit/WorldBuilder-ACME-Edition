using System.Data;
using MySqlConnector;

namespace WorldBuilder.Shared.Lib.AceDb;

/// <summary>
/// Bulk-ingest helpers for the ACE world DB. The creature / NPC roster
/// queries that lived here previously were superseded by the WeenieIndex
/// projection in Step 3 of the migration; what remains is the
/// landblock_instance bulk read (consumed by <c>ace-db ingest-spawns</c>)
/// and the housing portal read (consumed by <c>ace-db ingest-housing</c>).
/// Shared property-type constants live here so other partials in the
/// AceDbConnector class group can use them.
/// </summary>
public partial class AceDbConnector {

    // PropertyInt enum values from ACE.Entity.Enum.Properties.PropertyInt.
    // Tracking the small subset we read so the queries below stay readable.
    private const int PropInt_CreatureType = 2;
    private const int PropInt_Level        = 25;
    // PropertyString enum values. Name is the player-visible weenie name;
    // Title is the NPC's salutation (e.g. "Master Archer").
    private const int PropStr_Name  = 1;
    private const int PropStr_Title = 5;

    // The legacy IngestCreatureRosterAsync / IngestNpcRosterAsync methods
    // that lived here through 2026-04 used wrong WeenieType constants
    // (Vendor=20 was actually Chest, Talker=4 was actually Missile) and
    // silently wrote a roster of bowls, chests, and throwing weapons into
    // npc_gazetteer.json. They were superseded in Step 3 of the WeenieIndex
    // migration by the projection-based wrappers in
    // WorldBuilder.Terminal.CommandEngine. See AceDbConnector.WeenieIndex.cs
    // for the canonical fetch and CommandEngine.SiteIngest.cs for the
    // roster projections.

    /// <summary>
    /// Single-query bulk read of every <c>landblock_instance</c> row
    /// (outdoor + indoor). Used by <c>ingest-ace-spawns</c> to build
    /// a full per-LB SpawnRecord index without iterating the world LB by
    /// LB.
    /// </summary>
    public async Task<List<LandblockInstanceRecord>> GetAllInstancesAsync(
            CancellationToken ct = default) {
        var results = new List<LandblockInstanceRecord>();
        await using var conn = new MySqlConnection(_settings.ConnectionString);
        await conn.OpenAsync(ct);
        const string sql = @"
            SELECT `guid`, `weenie_Class_Id`, `obj_Cell_Id`,
                   `origin_X`, `origin_Y`, `origin_Z`,
                   `angles_w`, `angles_x`, `angles_y`, `angles_z`
            FROM `landblock_instance`";
        await using var cmd = new MySqlCommand(sql, conn);
        cmd.CommandTimeout = 600;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) {
            var rec = new LandblockInstanceRecord {
                Guid = reader.GetUInt32("guid"),
                WeenieClassId = reader.GetUInt32("weenie_Class_Id"),
                ObjCellId = reader.GetUInt32("obj_Cell_Id"),
                OriginX = reader.GetFloat("origin_X"),
                OriginY = reader.GetFloat("origin_Y"),
                OriginZ = reader.GetFloat("origin_Z"),
            };
            // ACE schema makes angles nullable; door/statue/etc. rows
            // typically populate them. Read only when present so the
            // ingest still works against pre-angles dumps.
            if (reader["angles_w"] != System.DBNull.Value) {
                rec.AnglesW = reader.GetFloat("angles_w");
                rec.AnglesX = reader.GetFloat("angles_x");
                rec.AnglesY = reader.GetFloat("angles_y");
                rec.AnglesZ = reader.GetFloat("angles_z");
            }
            results.Add(rec);
        }
        return results;
    }

    /// <summary>
    /// Reads the <c>house_portal</c> table — every row is a housing
    /// destination (one or more per house, keyed by the unique
    /// (house_Id, obj_Cell_Id) pair). Returned dict is keyed by house_Id.
    /// </summary>
    public async Task<Dictionary<uint, List<HouseRecord>>> IngestHousingRosterAsync(
            CancellationToken ct = default) {
        var result = new Dictionary<uint, List<HouseRecord>>();
        await using var conn = new MySqlConnection(_settings.ConnectionString);
        await conn.OpenAsync(ct);

        const string sql = @"
            SELECT
                house_Id, obj_Cell_Id,
                origin_X, origin_Y, origin_Z
            FROM `house_portal`";
        await using var cmd = new MySqlCommand(sql, conn);
        cmd.CommandTimeout = 120;

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) {
            uint houseId = reader.GetUInt32("house_Id");
            uint objCellId = reader.GetUInt32("obj_Cell_Id");
            float ox = reader.GetFloat("origin_X");
            float oy = reader.GetFloat("origin_Y");
            float oz = reader.GetFloat("origin_Z");
            if (!result.TryGetValue(houseId, out var list)) {
                list = new List<HouseRecord>();
                result[houseId] = list;
            }
            list.Add(new HouseRecord(houseId, objCellId, ox, oy, oz));
        }
        return result;
    }
}
