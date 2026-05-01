using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  O5: ACE DB Creature visual overrides
    // ─────────────────────────────────────────────────────────────────

    private AceDbConnector RequireAceDbConnector() {
        var settings = _projectManager.CurrentProject?.AceDb;
        if (settings == null || string.IsNullOrEmpty(settings.Host))
            throw new InvalidOperationException("ACE DB is not configured. Run 'ace-db connect' first.");
        return new AceDbConnector(settings);
    }

    public async Task<CreatureGetResult> CreatureGetAsync(uint objectId) {
        RequireProject();
        using var connector = RequireAceDbConnector();
        var overrides = await connector.LoadCreatureOverridesAsync(objectId);
        return new CreatureGetResult(true, objectId, overrides);
    }

    public async Task<CreatureSaveResult> CreatureSaveAsync(uint objectId, string? jsonPath) {
        RequireProject();

        AceCreatureOverrides? overrides = null;
        if (!string.IsNullOrEmpty(jsonPath)) {
            if (!File.Exists(jsonPath))
                throw new FileNotFoundException($"JSON file not found: {jsonPath}", jsonPath);
            overrides = JsonSerializer.Deserialize<AceCreatureOverrides>(
                File.ReadAllText(jsonPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }

        if (overrides == null)
            throw new ArgumentException("--from-json <path> is required.");

        overrides.ObjectId = objectId;
        using var connector = RequireAceDbConnector();
        var ok = await connector.SaveCreatureOverridesAsync(overrides);
        return new CreatureSaveResult(ok, objectId, overrides.TextureMap.Count, overrides.AnimParts.Count);
    }

    public CreatureExportSqlResult CreatureExportSql(uint objectId, string? outPath, AceCreatureOverrides? overrides = null) {
        RequireProject();
        if (overrides == null) {
            using var connector = RequireAceDbConnector();
            overrides = connector.LoadCreatureOverridesAsync(objectId).GetAwaiter().GetResult();
        }
        var sql = AceDbConnector.GenerateCreatureOverridesSql(overrides);
        if (!string.IsNullOrEmpty(outPath)) {
            File.WriteAllText(outPath, sql);
        }
        return new CreatureExportSqlResult(true, objectId, sql, outPath);
    }
}
