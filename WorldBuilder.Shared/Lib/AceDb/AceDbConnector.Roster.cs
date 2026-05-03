using System.Data;
using MySqlConnector;

namespace WorldBuilder.Shared.Lib.AceDb;

/// <summary>
/// Bulk-ingest queries that pull canonical creature / NPC / housing
/// rosters out of the ACE world DB. Distinct from the per-row
/// landblock_instance reads — these are wide table scans intended for
/// the static-site emitter's overlay generation step
/// (<c>ace-db ingest-creatures / ingest-npcs / ingest-housing</c>).
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

    // ACE WeenieType enum subset. The Vendor / Talker constants below were
    // historically wrong (Vendor = 12 and Talker isn't a real type — see
    // AceWeenieType in AceWeenieTypes.cs). The roster commands now project
    // from WeenieIndex which uses canonical values; these methods are kept
    // for one cycle to surface any external callers, then removed in Step 6
    // of the WeenieIndex migration.
    private const int WeenieType_Creature = 10;
    private const int WeenieType_Vendor   = 20;
    private const int WeenieType_Talker   = 4;

    /// <summary>
    /// Returns a wcid → CreatureRecord index of every WeenieType=10 row
    /// in the connected ACE DB, joined to its display name and creature
    /// type (when present). One round-trip; downstream callers can
    /// serialize to <c>creature_gazetteer.json</c> for the static site.
    /// </summary>
    [Obsolete("Use CommandEngine.IngestCreatureRosterAsync (projects from WeenieIndex). Removed in Step 6 of the WeenieIndex migration.")]
    public async Task<Dictionary<int, CreatureRecord>> IngestCreatureRosterAsync(
            CancellationToken ct = default) {
        var result = new Dictionary<int, CreatureRecord>();
        await using var conn = new MySqlConnection(_settings.ConnectionString);
        await conn.OpenAsync(ct);

        const string sql = @"
            SELECT
                w.class_Id   AS wcid,
                w.class_Name AS class_name,
                COALESCE(s.value, w.class_Name) AS display_name,
                ct.value     AS creature_type,
                lvl.value    AS level
            FROM `weenie` w
            LEFT JOIN `weenie_properties_string` s
                ON s.object_Id = w.class_Id AND s.type = @nameType
            LEFT JOIN `weenie_properties_int` ct
                ON ct.object_Id = w.class_Id AND ct.type = @creatureTypeProp
            LEFT JOIN `weenie_properties_int` lvl
                ON lvl.object_Id = w.class_Id AND lvl.type = @levelProp
            WHERE w.type = @creatureWeenieType";
        await using var cmd = new MySqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("@nameType", PropStr_Name);
        cmd.Parameters.AddWithValue("@creatureTypeProp", PropInt_CreatureType);
        cmd.Parameters.AddWithValue("@levelProp", PropInt_Level);
        cmd.Parameters.AddWithValue("@creatureWeenieType", WeenieType_Creature);
        cmd.CommandTimeout = 300;

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) {
            int wcid = reader.GetInt32("wcid");
            string className = reader.GetString("class_name");
            string displayName = reader.IsDBNull("display_name") ? className : reader.GetString("display_name");
            int? creatureType = reader.IsDBNull("creature_type") ? null : reader.GetInt32("creature_type");
            int? level = reader.IsDBNull("level") ? null : reader.GetInt32("level");
            result[wcid] = new CreatureRecord(wcid, className, displayName, creatureType, level);
        }
        return result;
    }

    /// <summary>
    /// Returns a wcid → NpcRecord index for every weenie whose type matches
    /// the legacy (incorrect) Vendor=20 / Talker=4 constants — those were
    /// actually Chest and Missile, so this method silently produced a
    /// roster of chests, coffins, and throwing weapons. Kept here for one
    /// cycle to surface external callers; the new
    /// <c>CommandEngine.IngestNpcRosterAsync</c> projects from WeenieIndex
    /// using canonical type values + the IsTalker flag stamped at ingest.
    /// </summary>
    [Obsolete("Use CommandEngine.IngestNpcRosterAsync (projects from WeenieIndex). Removed in Step 6 of the WeenieIndex migration.")]
    public async Task<Dictionary<int, NpcRecord>> IngestNpcRosterAsync(
            CancellationToken ct = default) {
        var result = new Dictionary<int, NpcRecord>();
        await using var conn = new MySqlConnection(_settings.ConnectionString);
        await conn.OpenAsync(ct);

        const string sql = @"
            SELECT
                w.class_Id   AS wcid,
                w.class_Name AS class_name,
                COALESCE(n.value, w.class_Name) AS display_name,
                w.type       AS weenie_type,
                t.value      AS title
            FROM `weenie` w
            LEFT JOIN `weenie_properties_string` n
                ON n.object_Id = w.class_Id AND n.type = @nameType
            LEFT JOIN `weenie_properties_string` t
                ON t.object_Id = w.class_Id AND t.type = @titleType
            WHERE w.type IN (@vendor, @talker)";
        await using var cmd = new MySqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("@nameType", PropStr_Name);
        cmd.Parameters.AddWithValue("@titleType", PropStr_Title);
        cmd.Parameters.AddWithValue("@vendor", WeenieType_Vendor);
        cmd.Parameters.AddWithValue("@talker", WeenieType_Talker);
        cmd.CommandTimeout = 300;

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) {
            int wcid = reader.GetInt32("wcid");
            string className = reader.GetString("class_name");
            string displayName = reader.IsDBNull("display_name") ? className : reader.GetString("display_name");
            int weenieType = reader.GetInt32("weenie_type");
            string? title = reader.IsDBNull("title") ? null : reader.GetString("title");
            result[wcid] = new NpcRecord(wcid, className, displayName, weenieType, title);
        }
        return result;
    }

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
