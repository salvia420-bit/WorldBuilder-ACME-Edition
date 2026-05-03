using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  WeenieIndex ingest — Step 1 of the canonical wcid identity
    //  migration (see weenie_index.md). Pulls the wcid → identity map
    //  from the connected ACE world DB and persists it as
    //  weenie_index.jsonl in the project directory. Subsequent steps
    //  wire the resolver, rosters, and overlay emitter to consume it.
    // ─────────────────────────────────────────────────────────────────

    public async Task<IngestWeenieIndexResult> IngestWeenieIndexAsync(string? outPath = null) {
        RequireProject();
        try {
            using var connector = RequireAceDbConnector();
            var index = await connector.IngestWeenieIndexAsync();

            string targetPath = outPath ?? Path.Combine(
                _projectManager.CurrentProject!.ProjectDirectory, "weenie_index.jsonl");
            int written = index.SaveJsonl(targetPath);

            // Stamp the in-memory copy too so the just-ingested data is
            // immediately consultable without a re-load.
            _weenieIndex = index;

            int withSetup = index.Entries.Count(e => e.SetupDid is not null);
            int serverManaged = index.Entries.Count(e => e.IsServerManaged);

            return new IngestWeenieIndexResult(
                Success: true,
                TotalEntries: written,
                WithSetupDid: withSetup,
                ServerManaged: serverManaged,
                OutputPath: targetPath);
        } catch (Exception ex) {
            return new IngestWeenieIndexResult(false, 0, 0, 0, null, ex.Message);
        }
    }
}
