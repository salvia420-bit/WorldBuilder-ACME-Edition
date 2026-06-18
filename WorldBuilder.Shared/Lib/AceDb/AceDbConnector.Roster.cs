using System.Data;
using MySqlConnector;
using WorldBuilder.Shared.Models;

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
    /// Single-query bulk read of every <c>encounter</c> row (whole world; no
    /// landblock-range predicate). The <c>landblock</c> column is a signed
    /// <c>int(5)</c> but every value is &lt; 65,536, so it narrows to a
    /// <c>ushort</c> losslessly. Consumed by <c>ace-db-ingest-encounters</c>.
    /// </summary>
    public async Task<List<EncounterRecord>> GetAllEncountersAsync(
            CancellationToken ct = default) {
        var results = new List<EncounterRecord>();
        await using var conn = new MySqlConnection(_settings.ConnectionString);
        await conn.OpenAsync(ct);
        const string sql = @"
            SELECT `landblock`, `weenie_Class_Id`, `cell_X`, `cell_Y`
            FROM `encounter`";
        await using var cmd = new MySqlCommand(sql, conn);
        cmd.CommandTimeout = 600;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) {
            results.Add(new EncounterRecord(
                Landblock: (ushort)reader.GetInt32("landblock"),
                WeenieClassId: reader.GetUInt32("weenie_Class_Id"),
                CellX: reader.GetInt32("cell_X"),
                CellY: reader.GetInt32("cell_Y")));
        }
        return results;
    }

    /// <summary>
    /// Bulk read of <c>weenie_properties_generator</c> — every generator
    /// profile in the world, keyed by owner <c>object_Id</c>. Mapped into the
    /// shared <see cref="PlacementGenerator"/> model (palette_Id →
    /// PaletteTemplate). SQL mirrors the canonical generator query at
    /// <c>CommandEngine.cs:6309-6315</c>, with a stable
    /// <c>ORDER BY object_Id, probability, weenie_Class_Id</c> so the
    /// probability ladder (and therefore the FNV-seeded weighted pick) is
    /// deterministic across runs.
    /// </summary>
    public async Task<Dictionary<uint, List<PlacementGenerator>>> GetAllGeneratorProfilesAsync(
            CancellationToken ct = default) {
        var result = new Dictionary<uint, List<PlacementGenerator>>();
        await using var conn = new MySqlConnection(_settings.ConnectionString);
        await conn.OpenAsync(ct);
        const string sql = @"
            SELECT `object_Id`, `probability`, `weenie_Class_Id`, `delay`,
                   `init_Create`, `max_Create`, `when_Create`, `where_Create`,
                   `stack_Size`, `palette_Id`, `shade`, `obj_Cell_Id`,
                   `origin_X`, `origin_Y`, `origin_Z`,
                   `angles_W`, `angles_X`, `angles_Y`, `angles_Z`
            FROM `weenie_properties_generator`
            ORDER BY `object_Id`, `probability`, `weenie_Class_Id`";
        await using var cmd = new MySqlCommand(sql, conn);
        cmd.CommandTimeout = 600;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) {
            uint objectId = reader.GetUInt32("object_Id");
            if (!result.TryGetValue(objectId, out var list)) {
                list = new List<PlacementGenerator>();
                result[objectId] = list;
            }
            list.Add(new PlacementGenerator {
                Probability   = reader.GetFloat("probability"),
                WeenieClassId = reader.GetUInt32("weenie_Class_Id"),
                Delay         = reader.IsDBNull(reader.GetOrdinal("delay")) ? null : reader.GetFloat("delay"),
                InitCreate    = reader.GetInt32("init_Create"),
                MaxCreate     = reader.GetInt32("max_Create"),
                WhenCreate    = reader.GetUInt32("when_Create"),
                WhereCreate   = reader.GetUInt32("where_Create"),
                StackSize     = reader.IsDBNull(reader.GetOrdinal("stack_Size")) ? null : reader.GetInt32("stack_Size"),
                PaletteTemplate = reader.IsDBNull(reader.GetOrdinal("palette_Id")) ? null : (int)reader.GetUInt32("palette_Id"),
                Shade         = reader.IsDBNull(reader.GetOrdinal("shade")) ? null : reader.GetFloat("shade"),
                ObjCellId     = reader.IsDBNull(reader.GetOrdinal("obj_Cell_Id")) ? null : reader.GetUInt32("obj_Cell_Id"),
                OriginX       = reader.IsDBNull(reader.GetOrdinal("origin_X")) ? null : reader.GetFloat("origin_X"),
                OriginY       = reader.IsDBNull(reader.GetOrdinal("origin_Y")) ? null : reader.GetFloat("origin_Y"),
                OriginZ       = reader.IsDBNull(reader.GetOrdinal("origin_Z")) ? null : reader.GetFloat("origin_Z"),
                AnglesW       = reader.IsDBNull(reader.GetOrdinal("angles_W")) ? null : reader.GetFloat("angles_W"),
                AnglesX       = reader.IsDBNull(reader.GetOrdinal("angles_X")) ? null : reader.GetFloat("angles_X"),
                AnglesY       = reader.IsDBNull(reader.GetOrdinal("angles_Y")) ? null : reader.GetFloat("angles_Y"),
                AnglesZ       = reader.IsDBNull(reader.GetOrdinal("angles_Z")) ? null : reader.GetFloat("angles_Z"),
            });
        }
        return result;
    }

    /// <summary>
    /// Bulk read of generator scatter radii: <c>weenie_properties_float</c>
    /// type 43 (GeneratorRadius), keyed by owner <c>object_Id</c>. Absent ⇒
    /// children spawn coincident with the anchor.
    /// </summary>
    public async Task<Dictionary<uint, float>> GetGeneratorRadiiAsync(
            CancellationToken ct = default) {
        var result = new Dictionary<uint, float>();
        await using var conn = new MySqlConnection(_settings.ConnectionString);
        await conn.OpenAsync(ct);
        const string sql = @"
            SELECT `object_Id`, `value` FROM `weenie_properties_float` WHERE `type` = 43";
        await using var cmd = new MySqlCommand(sql, conn);
        cmd.CommandTimeout = 600;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) {
            result[reader.GetUInt32("object_Id")] = (float)reader.GetDouble("value");
        }
        return result;
    }

    /// <summary>
    /// Bulk read of per-owner generator caps: <c>weenie_properties_int</c>
    /// type 81 (MaxGeneratedObjects), keyed by owner <c>object_Id</c>. Absent
    /// ⇒ fall back to the summed init_Create of the owner's profiles.
    /// </summary>
    public async Task<Dictionary<uint, int>> GetGeneratorMaxObjectsAsync(
            CancellationToken ct = default) {
        var result = new Dictionary<uint, int>();
        await using var conn = new MySqlConnection(_settings.ConnectionString);
        await conn.OpenAsync(ct);
        const string sql = @"
            SELECT `object_Id`, `value` FROM `weenie_properties_int` WHERE `type` = 81";
        await using var cmd = new MySqlCommand(sql, conn);
        cmd.CommandTimeout = 600;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) {
            result[reader.GetUInt32("object_Id")] = reader.GetInt32("value");
        }
        return result;
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
