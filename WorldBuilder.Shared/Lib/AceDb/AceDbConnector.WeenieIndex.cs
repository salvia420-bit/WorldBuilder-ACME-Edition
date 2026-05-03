using System.Data;
using MySqlConnector;

namespace WorldBuilder.Shared.Lib.AceDb;

/// <summary>
/// Bulk fetch of the canonical wcid → identity map. Joins the
/// <c>weenie</c> table against its property side-tables in a single
/// round trip. Output feeds <see cref="WeenieIndex"/>, which gates the
/// render pipeline's setup-DID resolver, the spawn-glyph dispatcher's
/// scale lookup, and the rosters that today re-derive the same join.
/// </summary>
public partial class AceDbConnector {

    // PropertyDataId enum values from ACE.Entity.Enum.Properties.PropertyDataId.
    // Mirroring AcePropertyDataId in AceWeenieTypes.cs — pinned here so the
    // SQL stays readable without an enum cast in the parameter binding.
    private const int PropDid_Setup       = 1;
    private const int PropDid_PaletteBase = 6;
    private const int PropDid_Icon        = 8;

    /// <summary>
    /// Returns the canonical <see cref="WeenieIndex"/> for the connected
    /// ACE world DB: every row in <c>weenie</c> joined to its display
    /// name + title strings, setup / icon / palette DIDs, and creature-type
    /// / level ints. One main bulk query plus a small side query for the
    /// <c>landblock_instance</c> placement set.
    ///
    /// Retail-sized world: ~80k weenies, ~250k property rows joined,
    /// completes in low single-digit seconds against a local MariaDB.
    /// </summary>
    public async Task<WeenieIndex> IngestWeenieIndexAsync(CancellationToken ct = default) {
        await using var conn = new MySqlConnection(_settings.ConnectionString);
        await conn.OpenAsync(ct);

        // Side query: the set of wcids that actually have placed instances
        // in the world. Used to stamp WeenieIndexEntry.IsServerManaged so a
        // consumer can tell template-only weenies (e.g. spawn-table outputs
        // never directly placed) from world-resident ones.
        var serverManagedWcids = new HashSet<int>();
        const string sqlPlaced = @"SELECT DISTINCT `weenie_Class_Id` FROM `landblock_instance`";
        await using (var cmdPlaced = new MySqlCommand(sqlPlaced, conn)) {
            cmdPlaced.CommandTimeout = 120;
            await using var rd = await cmdPlaced.ExecuteReaderAsync(ct);
            while (await rd.ReadAsync(ct)) {
                serverManagedWcids.Add((int)rd.GetUInt32(0));
            }
        }

        // Main bulk query — one round trip pulling every weenie row plus its
        // canonical property side-table values via LEFT JOIN. Each property
        // join is gated by `type` so a single weenie row carries a single
        // value per property (no row explosion).
        const string sql = @"
            SELECT
                w.class_Id   AS wcid,
                w.class_Name AS class_name,
                w.type       AS weenie_type,
                COALESCE(sn.value, w.class_Name) AS display_name,
                st.value     AS title,
                ds.value     AS setup_did,
                di.value     AS icon_did,
                dp.value     AS palette_base_did,
                ict.value    AS creature_type,
                ilv.value    AS level
            FROM `weenie` w
            LEFT JOIN `weenie_properties_string` sn
                ON sn.object_Id = w.class_Id AND sn.type = @propStrName
            LEFT JOIN `weenie_properties_string` st
                ON st.object_Id = w.class_Id AND st.type = @propStrTitle
            LEFT JOIN `weenie_properties_d_i_d` ds
                ON ds.object_Id = w.class_Id AND ds.type = @propDidSetup
            LEFT JOIN `weenie_properties_d_i_d` di
                ON di.object_Id = w.class_Id AND di.type = @propDidIcon
            LEFT JOIN `weenie_properties_d_i_d` dp
                ON dp.object_Id = w.class_Id AND dp.type = @propDidPalette
            LEFT JOIN `weenie_properties_int` ict
                ON ict.object_Id = w.class_Id AND ict.type = @propIntCreatureType
            LEFT JOIN `weenie_properties_int` ilv
                ON ilv.object_Id = w.class_Id AND ilv.type = @propIntLevel";

        await using var cmd = new MySqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("@propStrName",          PropStr_Name);
        cmd.Parameters.AddWithValue("@propStrTitle",         PropStr_Title);
        cmd.Parameters.AddWithValue("@propDidSetup",         PropDid_Setup);
        cmd.Parameters.AddWithValue("@propDidIcon",          PropDid_Icon);
        cmd.Parameters.AddWithValue("@propDidPalette",       PropDid_PaletteBase);
        cmd.Parameters.AddWithValue("@propIntCreatureType",  PropInt_CreatureType);
        cmd.Parameters.AddWithValue("@propIntLevel",         PropInt_Level);
        cmd.CommandTimeout = 600;

        var dict = new Dictionary<int, WeenieIndexEntry>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) {
            int    wcid       = reader.GetInt32("wcid");
            string className  = reader.GetString("class_name");
            int    weenieType = reader.GetInt32("weenie_type");
            string displayNm  = reader.IsDBNull("display_name") ? className : reader.GetString("display_name");
            string? title     = reader.IsDBNull("title")        ? null : reader.GetString("title");
            uint?  setupDid   = reader.IsDBNull("setup_did")    ? null : reader.GetUInt32("setup_did");
            uint?  iconDid    = reader.IsDBNull("icon_did")     ? null : reader.GetUInt32("icon_did");
            uint?  paletteDid = reader.IsDBNull("palette_base_did") ? null : reader.GetUInt32("palette_base_did");
            int?   creature   = reader.IsDBNull("creature_type") ? null : reader.GetInt32("creature_type");
            int?   level      = reader.IsDBNull("level")        ? null : reader.GetInt32("level");

            bool serverManaged = serverManagedWcids.Contains(wcid);

            dict[wcid] = new WeenieIndexEntry(
                Wcid: wcid,
                ClassName: className,
                WeenieType: weenieType,
                IsServerManaged: serverManaged,
                DisplayName: displayNm,
                Title: title,
                SetupDid: setupDid,
                IconDid: iconDid,
                PaletteBaseDid: paletteDid,
                CreatureType: creature,
                Level: level,
                SourceMask: WeenieSource.AceDb);
        }

        return new WeenieIndex(dict);
    }
}
