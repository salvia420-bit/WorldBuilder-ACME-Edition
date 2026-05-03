using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  WeenieIndex ingest — Step 1 of the canonical wcid identity
    //  migration (see weenie_index.md). Pulls the wcid → identity map
    //  from the connected ACE world DB and persists it as
    //  weenie_index.jsonl in the project directory. Subsequent steps
    //  wire the resolver, rosters, and overlay emitter to consume it.
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Read-only handle to the loaded WeenieIndex. Empty when the project
    /// hasn't been ingested. Consumers (the static-site emitter, the
    /// describer) consult this in lieu of re-deriving the wcid → identity
    /// map from disparate sources.
    /// </summary>
    public WeenieIndex WeenieIndex => _weenieIndex;

    /// <summary>
    /// Build the per-LB spawn payload that the static-site frontend expects
    /// in <c>overlays/spawns.js</c>. Joins each <see cref="SpawnRecord"/>
    /// against <see cref="WeenieIndex"/> for canonical title and icon DID
    /// when available; falls back to the spawn record's own fields when the
    /// index is empty.
    /// </summary>
    public IReadOnlyDictionary<string, IReadOnlyList<object>> BuildSpawnsOverlayPayload() {
        var result = new Dictionary<string, IReadOnlyList<object>>(_spawnGazetteer.Count);
        foreach (var (lbKey, records) in _spawnGazetteer) {
            string hex = $"0x{lbKey:X4}";
            var wire = new List<object>(records.Count);
            foreach (var sp in records) {
                var weenie = _weenieIndex.Get(sp.Wcid);
                wire.Add(new {
                    wcid          = sp.Wcid,
                    name          = sp.Name,
                    title         = weenie?.Title,
                    category      = sp.Category,
                    generator     = sp.Generator,
                    cell          = sp.Cell,
                    x             = sp.X,
                    y             = sp.Y,
                    z             = sp.Z,
                    weenieType    = sp.WeenieType ?? weenie?.WeenieType,
                    iconDid       = weenie?.IconDid,
                    setupDid      = weenie?.SetupDid,
                    isServerManaged = sp.IsServerManaged,
                    isSynthetic   = sp.IsSynthetic,
                    acpediaTitle  = sp.AcpediaTitle,
                    acpediaTier   = sp.AcpediaTier,
                });
            }
            result[hex] = wire;
        }
        return result;
    }

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
