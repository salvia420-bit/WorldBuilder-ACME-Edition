using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  O5: ACE DB Creature visual overrides
    // ─────────────────────────────────────────────────────────────────

    private AceDbConnector RequireAceDbConnector() {
        var settings = _projectManager.CurrentProject?.AceDb;
        if (settings == null || string.IsNullOrEmpty(settings.Host))
            throw new InvalidOperationException("ACE world DB is not configured. Run 'ace-db-connect' (JSON) or 'ace-db connect' (REPL) first.");
        return new AceDbConnector(settings);
    }

    public async Task<CreatureGetResult> CreatureGetAsync(uint objectId) {
        RequireProject();
        using var connector = RequireAceDbConnector();
        var overrides = await connector.LoadCreatureOverridesAsync(objectId);
        // Distinguish "no overrides defined" (success, empty collections) from a DB failure that
        // returned an empty/partial result. Propagating success=false here is what stops an agent's
        // get->edit->save during a DB blip from silently DELETEing all real rows on save.
        return new CreatureGetResult(!overrides.LoadFailed, objectId, overrides, overrides.LoadError);
    }

    public async Task<CreatureSaveResult> CreatureSaveAsync(uint objectId, string? jsonPath) {
        RequireProject();

        AceCreatureOverrides? overrides = null;
        if (!string.IsNullOrEmpty(jsonPath)) {
            if (!File.Exists(jsonPath))
                throw new FileNotFoundException($"JSON file not found: {jsonPath}", jsonPath);
            overrides = JsonSerializer.Deserialize<AceCreatureOverrides>(
                File.ReadAllText(jsonPath), JsonOpts.CaseInsensitive);
        }

        if (overrides == null)
            throw new ArgumentException("'fromJson' (path to an AceCreatureOverrides JSON file) is required.");

        overrides.ObjectId = objectId;
        if (objectId == 0)
            return new CreatureSaveResult(false, objectId, 0, 0, "objectId must be non-zero.");
        using var connector = RequireAceDbConnector();
        var ok = await connector.SaveCreatureOverridesAsync(overrides);
        return new CreatureSaveResult(ok, objectId,
            ok ? overrides.TextureMap.Count : 0, ok ? overrides.AnimParts.Count : 0,
            ok ? null : "Database write failed (connection or SQL error); no rows were written.");
    }

    public CreatureExportSqlResult CreatureExportSql(uint objectId, string? outPath, AceCreatureOverrides? overrides = null) {
        RequireProject();
        if (overrides == null) {
            using var connector = RequireAceDbConnector();
            overrides = connector.LoadCreatureOverridesAsync(objectId).GetAwaiter().GetResult();
        }
        // If the load failed, the overrides are empty/partial — refuse to write a misleading
        // "-- No overrides defined." file (or a partial export) and surface the error instead.
        if (overrides.LoadFailed)
            return new CreatureExportSqlResult(false, objectId, "", outPath, overrides.LoadError);

        var sql = AceDbConnector.GenerateCreatureOverridesSql(overrides);
        if (!string.IsNullOrEmpty(outPath)) {
            File.WriteAllText(outPath, sql);
        }
        return new CreatureExportSqlResult(true, objectId, sql, outPath);
    }
}
