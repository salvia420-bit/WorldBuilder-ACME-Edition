using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MySqlConnector;

namespace WorldBuilder.Shared.Lib.AceDb {
    public partial class AceDbConnector {

        /// <summary>Picker-list row: weenie class id + display name + setup DID for thumbnails.</summary>
        public record WeenieEntry(uint ClassId, string Name, uint SetupId);

        /// <summary>
        /// Loads weenie class IDs, names, and setup DIDs from ace_world for picker/list UI.
        /// Name comes from weenie_properties_string type 1 (PropertyString.Name).
        /// Setup DID comes from weenie_properties_d_i_d type 1 (PropertyDataId.Setup).
        /// </summary>
        /// <param name="search">Optional filter: names containing this text (case-insensitive). Supports partial matching.</param>
        /// <param name="limit">Max results (default 500).</param>
        public async Task<List<WeenieEntry>> GetWeenieNamesAsync(string? search = null, int limit = 500, CancellationToken ct = default) {
            var results = new List<WeenieEntry>();
            try {
                await using var conn = new MySqlConnection(_settings.ConnectionString);
                await conn.OpenAsync(ct);

                string sql;
                if (string.IsNullOrWhiteSpace(search)) {
                    sql = @"
                        SELECT n.`object_Id`, n.`value` AS `name`,
                               COALESCE(d.`value`, 0) AS `setup_did`
                        FROM `weenie_properties_string` n
                        LEFT JOIN `weenie_properties_d_i_d` d
                            ON d.`object_Id` = n.`object_Id` AND d.`type` = 1
                        WHERE n.`type` = 1
                        ORDER BY n.`value`
                        LIMIT @limit";
                }
                else {
                    sql = @"
                        SELECT n.`object_Id`, n.`value` AS `name`,
                               COALESCE(d.`value`, 0) AS `setup_did`
                        FROM `weenie_properties_string` n
                        LEFT JOIN `weenie_properties_d_i_d` d
                            ON d.`object_Id` = n.`object_Id` AND d.`type` = 1
                        WHERE n.`type` = 1
                          AND n.`value` LIKE CONCAT('%', @search, '%')
                        ORDER BY n.`value`
                        LIMIT @limit";
                }

                await using var cmd = new MySqlCommand(sql, conn);
                cmd.Parameters.AddWithValue("@limit", limit);
                if (!string.IsNullOrWhiteSpace(search))
                    cmd.Parameters.AddWithValue("@search", search.Trim());

                await using var reader = await cmd.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct)) {
                    results.Add(new WeenieEntry(
                        reader.GetUInt32("object_Id"),
                        reader.GetString("name"),
                        reader.IsDBNull(reader.GetOrdinal("setup_did")) ? 0 : reader.GetUInt32("setup_did")
                    ));
                }
            }
            catch (MySqlException) {
            }

            return results;
        }

        /// <summary>
        /// Batch lookup of Setup DIDs (PropertyDataId.Setup = type 1) for a set of weenie class IDs.
        /// Returns a dictionary mapping WCID -> Setup DID. WCIDs without a Setup are omitted.
        /// </summary>
        public async Task<Dictionary<uint, uint>> GetSetupDidsAsync(
            IEnumerable<uint> weenieClassIds, CancellationToken ct = default) {
            var result = new Dictionary<uint, uint>();
            var idList = new HashSet<uint>(weenieClassIds).ToList();
            if (idList.Count == 0) return result;

            try {
                await using var conn = new MySqlConnection(_settings.ConnectionString);
                await conn.OpenAsync(ct);

                for (int offset = 0; offset < idList.Count; offset += 500) {
                    var batch = idList.Skip(offset).Take(500).ToList();
                    var paramNames = string.Join(",", batch.Select((_, i) => $"@w{offset + i}"));
                    var sql = $@"SELECT `object_Id`, `value`
                                 FROM `weenie_properties_d_i_d`
                                 WHERE `type` = 1 AND `object_Id` IN ({paramNames})";

                    await using var cmd = new MySqlCommand(sql, conn);
                    for (int i = 0; i < batch.Count; i++)
                        cmd.Parameters.AddWithValue($"@w{offset + i}", batch[i]);

                    await using var reader = await cmd.ExecuteReaderAsync(ct);
                    while (await reader.ReadAsync(ct))
                        result.TryAdd(reader.GetUInt32("object_Id"), reader.GetUInt32("value"));
                }
            }
            catch (MySqlException) {
            }

            return result;
        }

        /// <summary>
        /// Loads scalar weenie properties and row counts for complex tables. Returns null ONLY when
        /// the weenie row is genuinely absent. A DB/infrastructure failure throws <see cref="MySqlException"/>
        /// (F235) — callers must distinguish "not found" (null) from "could not query" (thrown) so a
        /// dead connection is never reported as a missing weenie.
        /// </summary>
        public async Task<AceWeenieSnapshot?> LoadWeenieSnapshotAsync(uint classId, CancellationToken ct = default) {
            {
                await using var conn = new MySqlConnection(_settings.ConnectionString);
                await conn.OpenAsync(ct);

                uint type;
                DateTime? lastMod = null;
                await using (var cmd = new MySqlCommand(
                    "SELECT `type`, `last_Modified` FROM `weenie` WHERE `class_Id` = @id LIMIT 1", conn)) {
                    cmd.Parameters.AddWithValue("@id", classId);
                    await using var reader = await cmd.ExecuteReaderAsync(ct);
                    if (!await reader.ReadAsync(ct))
                        return null;
                    type = reader.GetUInt32("type");
                    var ord = reader.GetOrdinal("last_Modified");
                    if (!reader.IsDBNull(ord))
                        lastMod = reader.GetDateTime(ord);
                }

                var snap = new AceWeenieSnapshot {
                    ClassId = classId,
                    WeenieType = type,
                    LastModified = lastMod,
                };

                await FillIntsAsync(conn, classId, snap.Ints, ct);
                await FillInt64sAsync(conn, classId, snap.Int64s, ct);
                await FillBoolsAsync(conn, classId, snap.Bools, ct);
                await FillFloatsAsync(conn, classId, snap.Floats, ct);
                await FillStringsAsync(conn, classId, snap.Strings, ct);
                await FillDidsAsync(conn, classId, snap.DataIds, ct);
                await FillIidsAsync(conn, classId, snap.InstanceIds, ct);

                snap.SpellBookCount = await CountAsync(conn, "weenie_properties_spell_book", classId, ct);
                snap.CreateListCount = await CountAsync(conn, "weenie_properties_create_list", classId, ct);
                snap.EmoteCount = await CountAsync(conn, "weenie_properties_emote", classId, ct);
                snap.BookCount = await CountAsync(conn, "weenie_properties_book", classId, ct);
                snap.PositionCount = await CountAsync(conn, "weenie_properties_position", classId, ct);
                snap.AttributeCount = await CountAsync(conn, "weenie_properties_attribute", classId, ct);
                snap.Attribute2ndCount = await CountAsync(conn, "weenie_properties_attribute_2nd", classId, ct);
                snap.SkillCount = await CountAsync(conn, "weenie_properties_skill", classId, ct);

                return snap;
            }
        }

        /// <summary>
        /// Writes scalar properties only (does not touch spell book, create list, emotes, etc.).
        /// Updates <c>weenie.type</c> and <c>weenie.last_Modified</c>.
        /// Returns false when the weenie row does not exist (UPDATE matched 0 rows). A DB/infrastructure
        /// failure throws <see cref="MySqlException"/> (F235) rather than being silently swallowed to false.
        /// </summary>
        public async Task<bool> SaveWeenieScalarsAsync(AceWeenieSnapshot snapshot, CancellationToken ct = default) {
            if (snapshot.ClassId == 0) return false;
            {
                await using var conn = new MySqlConnection(_settings.ConnectionString);
                await conn.OpenAsync(ct);
                await using var tx = await conn.BeginTransactionAsync(ct);

                await using (var upd = new MySqlCommand(
                    "UPDATE `weenie` SET `type` = @type, `last_Modified` = UTC_TIMESTAMP() WHERE `class_Id` = @id",
                    conn, (MySqlTransaction)tx)) {
                    upd.Parameters.AddWithValue("@type", snapshot.WeenieType);
                    upd.Parameters.AddWithValue("@id", snapshot.ClassId);
                    var n = await upd.ExecuteNonQueryAsync(ct);
                    if (n == 0) {
                        await tx.RollbackAsync(ct);
                        return false;
                    }
                }

                uint id = snapshot.ClassId;
                await ReplaceRowsAsync(conn, tx, "weenie_properties_int", id,
                    "INSERT INTO `weenie_properties_int` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Ints, ct,
                    row => {
                        var p = new[] {
                            new MySqlParameter("@o", id),
                            new MySqlParameter("@t", row.Type),
                            new MySqlParameter("@v", row.Value),
                        };
                        return p;
                    });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_int64", id,
                    "INSERT INTO `weenie_properties_int64` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Int64s, ct,
                    row => new MySqlParameter[] {
                        new("@o", id),
                        new("@t", row.Type),
                        new("@v", row.Value),
                    });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_bool", id,
                    "INSERT INTO `weenie_properties_bool` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Bools, ct,
                    row => new MySqlParameter[] {
                        new("@o", id),
                        new("@t", row.Type),
                        new("@v", row.Value),
                    });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_float", id,
                    "INSERT INTO `weenie_properties_float` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Floats, ct,
                    row => new MySqlParameter[] {
                        new("@o", id),
                        new("@t", row.Type),
                        new("@v", row.Value),
                    });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_string", id,
                    "INSERT INTO `weenie_properties_string` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Strings, ct,
                    row => new MySqlParameter[] {
                        new("@o", id),
                        new("@t", row.Type),
                        new("@v", row.Value ?? ""),
                    });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_d_i_d", id,
                    "INSERT INTO `weenie_properties_d_i_d` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.DataIds, ct,
                    row => new MySqlParameter[] {
                        new("@o", id),
                        new("@t", row.Type),
                        new("@v", row.Value),
                    });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_i_i_d", id,
                    "INSERT INTO `weenie_properties_i_i_d` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.InstanceIds, ct,
                    row => new MySqlParameter[] {
                        new("@o", id),
                        new("@t", row.Type),
                        new("@v", row.Value),
                    });

                await tx.CommitAsync(ct);
                return true;
            }
        }

        /// <summary>
        /// Creates a new weenie (INSERT into ace_world.weenie) and saves all scalar properties.
        /// Auto-assigns the next available class_Id (minimum 100000 for custom content).
        /// Returns the assigned class_Id, or 0 when <paramref name="className"/> is blank.
        /// A DB/infrastructure failure throws <see cref="MySqlException"/> (F235).
        /// </summary>
        public async Task<uint> InsertWeenieAsync(string className, AceWeenieSnapshot snapshot, CancellationToken ct = default) {
            if (string.IsNullOrWhiteSpace(className)) return 0;
            {
                await using var conn = new MySqlConnection(_settings.ConnectionString);
                await conn.OpenAsync(ct);
                await using var tx = await conn.BeginTransactionAsync(ct);

                // F235: allocate the id inside the transaction under a SELECT ... FOR UPDATE so a
                // concurrent InsertWeenieAsync blocks here instead of reading the same MAX and
                // minting a duplicate class_Id. The lock is held until this transaction commits.
                uint newId;
                await using (var maxCmd = new MySqlCommand(
                    "SELECT COALESCE(MAX(`class_Id`), 0) FROM `weenie` FOR UPDATE", conn, (MySqlTransaction)tx)) {
                    var result = await maxCmd.ExecuteScalarAsync(ct);
                    var maxId = Convert.ToUInt32(result, CultureInfo.InvariantCulture);
                    newId = Math.Max(maxId + 1, 100000);
                }

                await using (var ins = new MySqlCommand(
                    "INSERT INTO `weenie` (`class_Id`, `class_Name`, `type`, `last_Modified`) VALUES (@id, @name, @type, UTC_TIMESTAMP())",
                    conn, (MySqlTransaction)tx)) {
                    ins.Parameters.AddWithValue("@id", newId);
                    ins.Parameters.AddWithValue("@name", className.Trim());
                    ins.Parameters.AddWithValue("@type", snapshot.WeenieType);
                    await ins.ExecuteNonQueryAsync(ct);
                }

                await ReplaceRowsAsync(conn, tx, "weenie_properties_int", newId,
                    "INSERT INTO `weenie_properties_int` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Ints, ct,
                    row => new MySqlParameter[] { new("@o", newId), new("@t", row.Type), new("@v", row.Value) });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_int64", newId,
                    "INSERT INTO `weenie_properties_int64` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Int64s, ct,
                    row => new MySqlParameter[] { new("@o", newId), new("@t", row.Type), new("@v", row.Value) });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_bool", newId,
                    "INSERT INTO `weenie_properties_bool` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Bools, ct,
                    row => new MySqlParameter[] { new("@o", newId), new("@t", row.Type), new("@v", row.Value) });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_float", newId,
                    "INSERT INTO `weenie_properties_float` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Floats, ct,
                    row => new MySqlParameter[] { new("@o", newId), new("@t", row.Type), new("@v", row.Value) });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_string", newId,
                    "INSERT INTO `weenie_properties_string` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.Strings, ct,
                    row => new MySqlParameter[] { new("@o", newId), new("@t", row.Type), new("@v", row.Value ?? "") });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_d_i_d", newId,
                    "INSERT INTO `weenie_properties_d_i_d` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.DataIds, ct,
                    row => new MySqlParameter[] { new("@o", newId), new("@t", row.Type), new("@v", row.Value) });

                await ReplaceRowsAsync(conn, tx, "weenie_properties_i_i_d", newId,
                    "INSERT INTO `weenie_properties_i_i_d` (`object_Id`, `type`, `value`) VALUES (@o, @t, @v)",
                    snapshot.InstanceIds, ct,
                    row => new MySqlParameter[] { new("@o", newId), new("@t", row.Type), new("@v", row.Value) });

                await tx.CommitAsync(ct);
                return newId;
            }
        }

        static async Task FillIntsAsync(MySqlConnection conn, uint classId, List<AceWeenieRowInt> list, CancellationToken ct) {
            const string sql = "SELECT `type`, `value` FROM `weenie_properties_int` WHERE `object_Id` = @id ORDER BY `type`";
            await using var cmd = new MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@id", classId);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                list.Add(new AceWeenieRowInt { Type = (ushort)reader.GetInt32("type"), Value = reader.GetInt32("value") });
        }

        static async Task FillInt64sAsync(MySqlConnection conn, uint classId, List<AceWeenieRowInt64> list, CancellationToken ct) {
            const string sql = "SELECT `type`, `value` FROM `weenie_properties_int64` WHERE `object_Id` = @id ORDER BY `type`";
            await using var cmd = new MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@id", classId);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                list.Add(new AceWeenieRowInt64 { Type = (ushort)reader.GetInt32("type"), Value = reader.GetInt64("value") });
        }

        static async Task FillBoolsAsync(MySqlConnection conn, uint classId, List<AceWeenieRowBool> list, CancellationToken ct) {
            const string sql = "SELECT `type`, `value` FROM `weenie_properties_bool` WHERE `object_Id` = @id ORDER BY `type`";
            await using var cmd = new MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@id", classId);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) {
                var t = (ushort)reader.GetInt32("type");
                var v = reader.GetValue(reader.GetOrdinal("value"));
                bool b = v switch {
                    bool bb => bb,
                    byte by => by != 0,
                    sbyte sb => sb != 0,
                    int i => i != 0,
                    long l => l != 0,
                    _ => Convert.ToInt32(v, CultureInfo.InvariantCulture) != 0,
                };
                list.Add(new AceWeenieRowBool { Type = t, Value = b });
            }
        }

        static async Task FillFloatsAsync(MySqlConnection conn, uint classId, List<AceWeenieRowFloat> list, CancellationToken ct) {
            const string sql = "SELECT `type`, `value` FROM `weenie_properties_float` WHERE `object_Id` = @id ORDER BY `type`";
            await using var cmd = new MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@id", classId);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                list.Add(new AceWeenieRowFloat { Type = (ushort)reader.GetInt32("type"), Value = reader.GetDouble("value") });
        }

        static async Task FillStringsAsync(MySqlConnection conn, uint classId, List<AceWeenieRowString> list, CancellationToken ct) {
            const string sql = "SELECT `type`, `value` FROM `weenie_properties_string` WHERE `object_Id` = @id ORDER BY `type`";
            await using var cmd = new MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@id", classId);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                list.Add(new AceWeenieRowString { Type = (ushort)reader.GetInt32("type"), Value = reader.GetString("value") });
        }

        static async Task FillDidsAsync(MySqlConnection conn, uint classId, List<AceWeenieRowDid> list, CancellationToken ct) {
            const string sql = "SELECT `type`, `value` FROM `weenie_properties_d_i_d` WHERE `object_Id` = @id ORDER BY `type`";
            await using var cmd = new MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@id", classId);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                list.Add(new AceWeenieRowDid { Type = (ushort)reader.GetInt32("type"), Value = reader.GetUInt32("value") });
        }

        static async Task FillIidsAsync(MySqlConnection conn, uint classId, List<AceWeenieRowIid> list, CancellationToken ct) {
            const string sql = "SELECT `type`, `value` FROM `weenie_properties_i_i_d` WHERE `object_Id` = @id ORDER BY `type`";
            await using var cmd = new MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@id", classId);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                list.Add(new AceWeenieRowIid { Type = (ushort)reader.GetInt32("type"), Value = reader.GetUInt64("value") });
        }

        /// <summary>
        /// Deletes a weenie and every <c>weenie_properties_*</c> row that points at its
        /// <c>class_Id</c>. The wipe runs in a single transaction so a partial failure
        /// rolls back. Returns true when the weenie row itself existed and was deleted;
        /// false when no such weenie row existed. A DB/infrastructure failure throws
        /// <see cref="MySqlException"/> (F235) rather than being swallowed to false.
        /// </summary>
        public async Task<bool> DeleteWeenieAsync(uint classId, CancellationToken ct = default) {
            {
                await using var conn = new MySqlConnection(_settings.ConnectionString);
                await conn.OpenAsync(ct);
                await using var tx = await conn.BeginTransactionAsync(ct);

                string[] propTables = {
                    "weenie_properties_int", "weenie_properties_int64",
                    "weenie_properties_bool", "weenie_properties_float",
                    "weenie_properties_string", "weenie_properties_d_i_d",
                    "weenie_properties_i_i_d", "weenie_properties_position",
                    "weenie_properties_attribute", "weenie_properties_attribute_2nd",
                    "weenie_properties_skill", "weenie_properties_spell_book",
                    "weenie_properties_create_list", "weenie_properties_emote",
                    "weenie_properties_emote_action", "weenie_properties_book",
                    "weenie_properties_book_page_data", "weenie_properties_palette",
                    "weenie_properties_texture_map", "weenie_properties_anim_part",
                    "weenie_properties_body_part", "weenie_properties_event_filter",
                    "weenie_properties_generator"
                };
                foreach (var t in propTables) {
                    await using var del = new MySqlCommand(
                        $"DELETE FROM `{t}` WHERE `object_Id` = @id", conn, (MySqlTransaction)tx);
                    del.Parameters.AddWithValue("@id", classId);
                    try { await del.ExecuteNonQueryAsync(ct); }
                    catch (MySqlException) { /* table may not exist on older schemas */ }
                }

                int deleted;
                await using (var del = new MySqlCommand(
                    "DELETE FROM `weenie` WHERE `class_Id` = @id", conn, (MySqlTransaction)tx)) {
                    del.Parameters.AddWithValue("@id", classId);
                    deleted = await del.ExecuteNonQueryAsync(ct);
                }

                await tx.CommitAsync(ct);
                return deleted > 0;
            }
        }

        static async Task<int> CountAsync(MySqlConnection conn, string table, uint classId, CancellationToken ct) {
            var sql = $@"SELECT COUNT(*) FROM `{table}` WHERE `object_Id` = @id";
            await using var cmd = new MySqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@id", classId);
            var o = await cmd.ExecuteScalarAsync(ct);
            return Convert.ToInt32(o, CultureInfo.InvariantCulture);
        }

        static async Task ReplaceRowsAsync<T>(MySqlConnection conn, MySqlTransaction tx, string table, uint classId,
            string insertSql, List<T> rows, CancellationToken ct, Func<T, MySqlParameter[]> paramFactory) {
            await using (var del = new MySqlCommand($"DELETE FROM `{table}` WHERE `object_Id` = @id", conn, tx)) {
                del.Parameters.AddWithValue("@id", classId);
                await del.ExecuteNonQueryAsync(ct);
            }
            foreach (var row in rows) {
                await using var ins = new MySqlCommand(insertSql, conn, tx);
                ins.Parameters.AddRange(paramFactory(row));
                await ins.ExecuteNonQueryAsync(ct);
            }
        }
    }
}
