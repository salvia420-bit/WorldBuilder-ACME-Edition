using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MySqlConnector;

namespace WorldBuilder.Shared.Lib.AceDb {
    public partial class AceDbConnector {

        /// <summary>
        /// Loads all <c>weenie_properties_texture_map</c> and <c>weenie_properties_anim_part</c>
        /// rows for the given object/weenie ID. Returns an empty result (not null) on failure.
        /// </summary>
        public async Task<AceCreatureOverrides> LoadCreatureOverridesAsync(uint objectId, CancellationToken ct = default) {
            var result = new AceCreatureOverrides { ObjectId = objectId };
            try {
                await using var conn = new MySqlConnection(_settings.ConnectionString);
                await conn.OpenAsync(ct);

                const string texSql = @"
                    SELECT `index`, `old_Id`, `new_Id`
                    FROM `weenie_properties_texture_map`
                    WHERE `object_Id` = @id
                    ORDER BY `index`, `old_Id`";
                await using (var cmd = new MySqlCommand(texSql, conn)) {
                    cmd.Parameters.AddWithValue("@id", objectId);
                    await using var reader = await cmd.ExecuteReaderAsync(ct);
                    while (await reader.ReadAsync(ct)) {
                        result.TextureMap.Add(new AceTextureMapRow {
                            Index = reader.GetByte("index"),
                            OldId = reader.GetUInt32("old_Id"),
                            NewId = reader.GetUInt32("new_Id"),
                        });
                    }
                }

                const string animSql = @"
                    SELECT `index`, `animation_Id`
                    FROM `weenie_properties_anim_part`
                    WHERE `object_Id` = @id
                    ORDER BY `index`";
                await using (var cmd = new MySqlCommand(animSql, conn)) {
                    cmd.Parameters.AddWithValue("@id", objectId);
                    await using var reader = await cmd.ExecuteReaderAsync(ct);
                    while (await reader.ReadAsync(ct)) {
                        result.AnimParts.Add(new AceAnimPartRow {
                            Index = reader.GetByte("index"),
                            AnimationId = reader.GetUInt32("animation_Id"),
                        });
                    }
                }
            }
            catch (MySqlException) { }
            return result;
        }

        /// <summary>
        /// Replaces all <c>weenie_properties_texture_map</c> and <c>weenie_properties_anim_part</c>
        /// rows for the given object ID in a single transaction. Returns true on success.
        /// </summary>
        public async Task<bool> SaveCreatureOverridesAsync(AceCreatureOverrides overrides, CancellationToken ct = default) {
            if (overrides.ObjectId == 0) return false;
            try {
                await using var conn = new MySqlConnection(_settings.ConnectionString);
                await conn.OpenAsync(ct);
                await using var tx = await conn.BeginTransactionAsync(ct);

                await using (var del = new MySqlCommand(
                    "DELETE FROM `weenie_properties_texture_map` WHERE `object_Id` = @id",
                    conn, (MySqlTransaction)tx)) {
                    del.Parameters.AddWithValue("@id", overrides.ObjectId);
                    await del.ExecuteNonQueryAsync(ct);
                }
                foreach (var row in overrides.TextureMap) {
                    await using var ins = new MySqlCommand(
                        "INSERT INTO `weenie_properties_texture_map` (`object_Id`, `index`, `old_Id`, `new_Id`) VALUES (@o, @i, @old, @new)",
                        conn, (MySqlTransaction)tx);
                    ins.Parameters.AddWithValue("@o", overrides.ObjectId);
                    ins.Parameters.AddWithValue("@i", row.Index);
                    ins.Parameters.AddWithValue("@old", row.OldId);
                    ins.Parameters.AddWithValue("@new", row.NewId);
                    await ins.ExecuteNonQueryAsync(ct);
                }

                await using (var del = new MySqlCommand(
                    "DELETE FROM `weenie_properties_anim_part` WHERE `object_Id` = @id",
                    conn, (MySqlTransaction)tx)) {
                    del.Parameters.AddWithValue("@id", overrides.ObjectId);
                    await del.ExecuteNonQueryAsync(ct);
                }
                foreach (var row in overrides.AnimParts) {
                    await using var ins = new MySqlCommand(
                        "INSERT INTO `weenie_properties_anim_part` (`object_Id`, `index`, `animation_Id`) VALUES (@o, @i, @anim)",
                        conn, (MySqlTransaction)tx);
                    ins.Parameters.AddWithValue("@o", overrides.ObjectId);
                    ins.Parameters.AddWithValue("@i", row.Index);
                    ins.Parameters.AddWithValue("@anim", row.AnimationId);
                    await ins.ExecuteNonQueryAsync(ct);
                }

                await tx.CommitAsync(ct);
                return true;
            }
            catch (MySqlException) {
                return false;
            }
        }

        /// <summary>
        /// Generates idempotent SQL (DELETE + INSERT) for the given overrides, ready to paste
        /// into a MySQL client or the ACE world database. Matches the style used by the community.
        /// </summary>
        public static string GenerateCreatureOverridesSql(AceCreatureOverrides overrides) {
            var sb = new StringBuilder();
            sb.AppendLine($"-- ACME WorldBuilder: Monster Creator — WCID {overrides.ObjectId}");
            sb.AppendLine();

            if (overrides.TextureMap.Count > 0) {
                sb.AppendLine($"DELETE FROM `weenie_properties_texture_map` WHERE `object_Id` = {overrides.ObjectId};");
                sb.AppendLine("INSERT INTO `weenie_properties_texture_map` (`object_Id`, `index`, `old_Id`, `new_Id`)");
                sb.Append("VALUES ");
                for (int i = 0; i < overrides.TextureMap.Count; i++) {
                    var row = overrides.TextureMap[i];
                    bool last = i == overrides.TextureMap.Count - 1;
                    var comment = string.IsNullOrWhiteSpace(row.Comment) ? "" : $" /* {row.Comment.Trim()} */";
                    if (i == 0)
                        sb.Append($"({overrides.ObjectId}, {row.Index,2}, 0x{row.OldId:X8}, 0x{row.NewId:X8}){comment}");
                    else
                        sb.Append($"\n     ,({overrides.ObjectId}, {row.Index,2}, 0x{row.OldId:X8}, 0x{row.NewId:X8}){comment}");
                    if (last) sb.AppendLine(";");
                }
                sb.AppendLine();
            }

            if (overrides.AnimParts.Count > 0) {
                sb.AppendLine($"DELETE FROM `weenie_properties_anim_part` WHERE `object_Id` = {overrides.ObjectId};");
                sb.AppendLine("INSERT INTO `weenie_properties_anim_part` (`object_Id`, `index`, `animation_Id`)");
                sb.Append("VALUES ");
                for (int i = 0; i < overrides.AnimParts.Count; i++) {
                    var row = overrides.AnimParts[i];
                    bool last = i == overrides.AnimParts.Count - 1;
                    var comment = string.IsNullOrWhiteSpace(row.Comment) ? "" : $" /* {row.Comment.Trim()} */";
                    if (i == 0)
                        sb.Append($"({overrides.ObjectId}, {row.Index,2}, 0x{row.AnimationId:X8}){comment}");
                    else
                        sb.Append($"\n     ,({overrides.ObjectId}, {row.Index,2}, 0x{row.AnimationId:X8}){comment}");
                    if (last) sb.AppendLine(";");
                }
                sb.AppendLine();
            }

            if (overrides.TextureMap.Count == 0 && overrides.AnimParts.Count == 0)
                sb.AppendLine("-- No overrides defined.");

            return sb.ToString();
        }
    }
}
