using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MySqlConnector;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// Thin wrapper around MySqlConnector for reading/writing the ACE
    /// ace_world.landblock_instance table.
    /// </summary>
    public partial class AceDbConnector : IDisposable {
        private readonly AceDbSettings _settings;

        public AceDbConnector(AceDbSettings settings) {
            _settings = settings ?? throw new ArgumentNullException(nameof(settings));
        }

        /// <summary>
        /// Tests the MySQL connection. Returns null on success or the error message on failure.
        /// </summary>
        public async Task<string?> TestConnectionAsync(CancellationToken ct = default) {
            try {
                await using var conn = new MySqlConnection(_settings.ConnectionString);
                await conn.OpenAsync(ct);
                return null;
            }
            catch (Exception ex) {
                return ex.Message;
            }
        }

        /// <summary>
        /// Queries all outdoor landblock_instance rows for the given landblock IDs.
        /// Outdoor cells have cell numbers 0x0001–0x0040 (1–64).
        /// Uses a single bulk query for large sets, batched queries for smaller ones.
        /// </summary>
        public async Task<List<LandblockInstanceRecord>> GetOutdoorInstancesAsync(
            IEnumerable<ushort> landblockIds, CancellationToken ct = default) {

            var lbSet = new HashSet<ushort>(landblockIds);
            var results = new List<LandblockInstanceRecord>();
            await using var conn = new MySqlConnection(_settings.ConnectionString);
            await conn.OpenAsync(ct);

            if (lbSet.Count > 500) {
                // For large sets, fetch all outdoor instances in one query and filter in memory
                const string sql = @"
                    SELECT `guid`, `weenie_Class_Id`, `obj_Cell_Id`,
                           `origin_X`, `origin_Y`, `origin_Z`
                    FROM `landblock_instance`
                    WHERE (`obj_Cell_Id` & 0xFFFF) BETWEEN 1 AND 64";

                await using var cmd = new MySqlCommand(sql, conn);
                cmd.CommandTimeout = 300;
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct)) {
                    uint objCellId = reader.GetUInt32("obj_Cell_Id");
                    ushort lbId = (ushort)(objCellId >> 16);
                    if (!lbSet.Contains(lbId)) continue;

                    results.Add(new LandblockInstanceRecord {
                        Guid = reader.GetUInt32("guid"),
                        WeenieClassId = reader.GetUInt32("weenie_Class_Id"),
                        ObjCellId = objCellId,
                        OriginX = reader.GetFloat("origin_X"),
                        OriginY = reader.GetFloat("origin_Y"),
                        OriginZ = reader.GetFloat("origin_Z"),
                    });
                }
            }
            else {
                // For small sets, query per landblock
                foreach (var lbId in lbSet) {
                    uint lbIdShifted = (uint)lbId << 16;
                    uint minCellId = lbIdShifted | 0x0001;
                    uint maxCellId = lbIdShifted | 0x0040;

                    const string sql = @"
                        SELECT `guid`, `weenie_Class_Id`, `obj_Cell_Id`,
                               `origin_X`, `origin_Y`, `origin_Z`
                        FROM `landblock_instance`
                        WHERE `obj_Cell_Id` >= @minCell AND `obj_Cell_Id` <= @maxCell";

                    await using var cmd = new MySqlCommand(sql, conn);
                    cmd.Parameters.AddWithValue("@minCell", minCellId);
                    cmd.Parameters.AddWithValue("@maxCell", maxCellId);

                    await using var reader = await cmd.ExecuteReaderAsync(ct);
                    while (await reader.ReadAsync(ct)) {
                        results.Add(new LandblockInstanceRecord {
                            Guid = reader.GetUInt32("guid"),
                            WeenieClassId = reader.GetUInt32("weenie_Class_Id"),
                            ObjCellId = reader.GetUInt32("obj_Cell_Id"),
                            OriginX = reader.GetFloat("origin_X"),
                            OriginY = reader.GetFloat("origin_Y"),
                            OriginZ = reader.GetFloat("origin_Z"),
                        });
                    }
                }
            }

            return results;
        }

        /// <summary>
        /// Queries landblock_instance rows for a single landblock, optionally restricted by cell range.
        /// Use this to load all instances (outdoor + dungeon), or only outdoor cells (1..64) for
        /// weenie spawn rendering. When includeAngles is true, reads angles_w/x/y/z so the
        /// orientation can be reconstructed for in-world rendering.
        /// </summary>
        public async Task<List<LandblockInstanceRecord>> GetInstancesAsync(
            ushort landblockId,
            ushort? cellMin = null,
            ushort? cellMax = null,
            bool includeAngles = true,
            CancellationToken ct = default) {

            ushort cMin = cellMin ?? 1;
            ushort cMax = cellMax ?? 0xFFFE;
            uint lbIdShifted = (uint)landblockId << 16;
            uint minCellId = lbIdShifted | cMin;
            uint maxCellId = lbIdShifted | cMax;

            string cols = includeAngles
                ? "`guid`, `weenie_Class_Id`, `obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_w`, `angles_x`, `angles_y`, `angles_z`"
                : "`guid`, `weenie_Class_Id`, `obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`";

            string sql = $@"
                SELECT {cols}
                FROM `landblock_instance`
                WHERE `obj_Cell_Id` >= @minCell AND `obj_Cell_Id` <= @maxCell";

            var results = new List<LandblockInstanceRecord>();
            await using var conn = new MySqlConnection(_settings.ConnectionString);
            await conn.OpenAsync(ct);
            await using var cmd = new MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@minCell", minCellId);
            cmd.Parameters.AddWithValue("@maxCell", maxCellId);

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
                if (includeAngles && reader["angles_w"] != System.DBNull.Value) {
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
        /// Queries indoor (interior cell) landblock_instance rows for the
        /// given landblocks. Indoor cells are 0x0100–0xFFFD. Used by the
        /// reposition service's indoor pass — these NPCs need to ride the
        /// building's Z delta, not the terrain delta.
        /// </summary>
        public async Task<List<LandblockInstanceRecord>> GetIndoorInstancesAsync(
            IEnumerable<ushort> landblockIds, CancellationToken ct = default) {

            var results = new List<LandblockInstanceRecord>();
            await using var conn = new MySqlConnection(_settings.ConnectionString);
            await conn.OpenAsync(ct);

            foreach (var lbId in landblockIds) {
                uint lbIdShifted = (uint)lbId << 16;
                uint minCellId = lbIdShifted | 0x0100;
                uint maxCellId = lbIdShifted | 0xFFFD;

                const string sql = @"
                    SELECT `guid`, `weenie_Class_Id`, `obj_Cell_Id`,
                           `origin_X`, `origin_Y`, `origin_Z`
                    FROM `landblock_instance`
                    WHERE `obj_Cell_Id` >= @minCell AND `obj_Cell_Id` <= @maxCell";

                await using var cmd = new MySqlCommand(sql, conn);
                cmd.Parameters.AddWithValue("@minCell", minCellId);
                cmd.Parameters.AddWithValue("@maxCell", maxCellId);

                await using var reader = await cmd.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct)) {
                    results.Add(new LandblockInstanceRecord {
                        Guid = reader.GetUInt32("guid"),
                        WeenieClassId = reader.GetUInt32("weenie_Class_Id"),
                        ObjCellId = reader.GetUInt32("obj_Cell_Id"),
                        OriginX = reader.GetFloat("origin_X"),
                        OriginY = reader.GetFloat("origin_Y"),
                        OriginZ = reader.GetFloat("origin_Z"),
                    });
                }
            }

            return results;
        }

        /// <summary>
        /// Executes a batch of SQL statements (the generated reposition script) against the database.
        /// </summary>
        public async Task<int> ExecuteSqlAsync(string sql, CancellationToken ct = default) {
            await using var conn = new MySqlConnection(_settings.ConnectionString);
            await conn.OpenAsync(ct);
            await using var cmd = new MySqlCommand(sql, conn);
            return await cmd.ExecuteNonQueryAsync(ct);
        }

        public void Dispose() { }
    }
}
