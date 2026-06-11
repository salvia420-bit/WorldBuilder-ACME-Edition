using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Threading.Tasks;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  O6: Outdoor + Dungeon Instance Placements
    // ─────────────────────────────────────────────────────────────────

    public string GetCurrentProjectDirectoryOrCwd() {
        return _projectManager.CurrentProject?.ProjectDirectory ?? Directory.GetCurrentDirectory();
    }

    /// <summary>
    /// F164 — the SINGLE deterministically-ordered DungeonDocument sequence shared by
    /// placement-list / -remove / -set-scope so the global flattened index they report and address
    /// is stable. <see cref="System.Collections.Concurrent.ConcurrentDictionary{TKey,TValue}"/>
    /// enumeration order is unspecified, so we sort by LandblockKey (then doc Id as a tiebreaker for
    /// any zero-key docs) before flattening.
    /// </summary>
    private List<DungeonDocument> OrderedDungeonDocs(WorldBuilder.Shared.Models.Project project) {
        return project.DocumentManager.ActiveDocs.Values
            .OfType<DungeonDocument>()
            .OrderBy(d => d.LandblockKey)
            .ThenBy(d => d.Id, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// F165 — load EVERY persisted dungeon_ document into ActiveDocs so a dungeon placement persisted in
    /// an earlier session (and never re-opened this session) is visible to placement-list / -export-sql.
    /// Enumerating only ActiveDocs silently OMITS those rows. Unions storage ids with ActiveDocs via
    /// GetOrCreateDocumentAsync (which is a no-op for already-loaded docs).
    /// </summary>
    private void EnsureAllDungeonDocsLoaded(WorldBuilder.Shared.Models.Project project) {
        var ids = project.DocumentManager.DocumentStorageService
            .ListDocumentIdsAsync("dungeon_").GetAwaiter().GetResult();
        foreach (var id in ids) {
            project.DocumentManager
                .GetOrCreateDocumentAsync<DungeonDocument>(id)
                .GetAwaiter().GetResult();
        }
    }

    public PlacementListResult PlacementList(int? lbX, int? lbY, string kindFilter) {
        RequireProject();
        var project = _projectManager.CurrentProject!;

        ushort? lbKey = (lbX.HasValue && lbY.HasValue)
            ? (ushort)(((uint)lbX.Value << 8) | (uint)lbY.Value)
            : null;

        bool wantsOutdoor = kindFilter is "all" or "outdoor";
        bool wantsDungeon = kindFilter is "all" or "dungeon";

        var outdoor = wantsOutdoor
            ? project.OutdoorInstancePlacements
                .Where(p => !lbKey.HasValue || p.LandblockId == lbKey.Value)
                .Select((p, i) => new PlacementListRow(
                    Kind: "outdoor",
                    Index: i,
                    Landblock: $"0x{p.LandblockId:X4}",
                    Wcid: p.WeenieClassId,
                    CellNumber: p.CellNumber,
                    OriginX: p.OriginX, OriginY: p.OriginY, OriginZ: p.OriginZ,
                    AnglesW: p.AnglesW, AnglesX: p.AnglesX, AnglesY: p.AnglesY, AnglesZ: p.AnglesZ))
                .ToList()
            : new List<PlacementListRow>();

        var dungeon = new List<PlacementListRow>();
        if (wantsDungeon) {
            // F165: pull in dungeon docs persisted in earlier sessions so none are silently omitted.
            EnsureAllDungeonDocsLoaded(project);
            // F164: report a FLATTENED GLOBAL index over the deterministically-ordered doc sequence
            // (the same order placement-remove / -set-scope address), so the index the caller sees is
            // the index they can act on — even with the landblock filter applied (the global counter
            // advances across skipped docs).
            int global = 0;
            foreach (var dng in OrderedDungeonDocs(project)) {
                for (int i = 0; i < dng.InstancePlacements.Count; i++, global++) {
                    if (lbKey.HasValue && dng.LandblockKey != lbKey.Value) continue;
                    var p = dng.InstancePlacements[i];
                    dungeon.Add(new PlacementListRow(
                        Kind: "dungeon",
                        Index: global,
                        Landblock: $"0x{dng.LandblockKey:X4}",
                        Wcid: p.WeenieClassId,
                        CellNumber: p.CellNumber,
                        OriginX: p.Origin.X, OriginY: p.Origin.Y, OriginZ: p.Origin.Z,
                        AnglesW: p.Orientation.W, AnglesX: p.Orientation.X,
                        AnglesY: p.Orientation.Y, AnglesZ: p.Orientation.Z));
                }
            }
        }

        var rows = outdoor.Concat(dungeon).ToList();
        return new PlacementListResult(rows.Count, kindFilter, rows);
    }

    public PlacementAddResult PlacementAddOutdoor(int lbX, int lbY, uint wcid, ushort cellNumber,
        float originX, float originY, float originZ,
        float? angW, float? angX, float? angY, float? angZ) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        var p = new OutdoorInstancePlacement {
            LandblockId = (ushort)(((uint)lbX << 8) | (uint)lbY),
            WeenieClassId = wcid,
            CellNumber = cellNumber,
            OriginX = originX, OriginY = originY, OriginZ = originZ,
            // F166: default orientation is IDENTITY (w=1, z=0), not (w=0, z=1) which is a 180° flip.
            AnglesW = angW ?? 1f, AnglesX = angX ?? 0f,
            AnglesY = angY ?? 0f, AnglesZ = angZ ?? 0f,
        };
        project.OutdoorInstancePlacements.Add(p);
        project.Save();
        return new PlacementAddResult(true, "outdoor", project.OutdoorInstancePlacements.Count - 1, $"0x{p.LandblockId:X4}");
    }

    public PlacementAddResult PlacementAddDungeon(int lbX, int lbY, uint wcid, ushort cellNumber,
        float originX, float originY, float originZ,
        float? angW, float? angX, float? angY, float? angZ) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        ushort lbKey = (ushort)(((uint)lbX << 8) | (uint)lbY);

        var dng = project.DocumentManager
            .GetOrCreateDocumentAsync<DungeonDocument>($"dungeon_{lbKey:X4}")
            .GetAwaiter().GetResult()
            ?? throw new InvalidOperationException($"Could not load DungeonDocument for 0x{lbKey:X4}.");
        if (dng.LandblockKey == 0) dng.SetLandblockKey(lbKey);

        var p = new DungeonInstancePlacement {
            WeenieClassId = wcid,
            CellNumber = cellNumber,
            Origin = new Vector3(originX, originY, originZ),
            // F166: System.Numerics.Quaternion ctor is (x,y,z,w); default to IDENTITY (w=1),
            // not (z=1,w=0) which is a 180° flip → object spawns facing backwards in ACE.
            Orientation = new Quaternion(angX ?? 0f, angY ?? 0f, angZ ?? 0f, angW ?? 1f),
        };
        dng.InstancePlacements.Add(p);
        // F163: direct List mutation raises NO Update event, so without this the row is lost on
        // reload (silent data loss of a committed edit). ForceSave marks the doc dirty + raises
        // Update so the DocumentManager batch-persists it.
        dng.ForceSave();
        return new PlacementAddResult(true, "dungeon", dng.InstancePlacements.Count - 1, $"0x{lbKey:X4}");
    }

    public PlacementRemoveResult PlacementRemove(string kind, int index) {
        RequireProject();
        var project = _projectManager.CurrentProject!;
        if (kind.Equals("outdoor", StringComparison.OrdinalIgnoreCase)) {
            if (index < 0 || index >= project.OutdoorInstancePlacements.Count)
                return new PlacementRemoveResult(false, kind, index, null);
            var lb = $"0x{project.OutdoorInstancePlacements[index].LandblockId:X4}";
            project.OutdoorInstancePlacements.RemoveAt(index);
            project.Save();
            return new PlacementRemoveResult(true, kind, index, lb);
        }

        if (kind.Equals("dungeon", StringComparison.OrdinalIgnoreCase)) {
            // F164: reject a negative global index explicitly (the outdoor path returns
            // success:false; the dungeon path used to surface a raw ArgumentOutOfRangeException).
            if (index < 0) return new PlacementRemoveResult(false, kind, index, null);
            int total = 0;
            // F164: walk the SAME deterministically-ordered doc sequence placement-list reports.
            foreach (var dng in OrderedDungeonDocs(project)) {
                if (index >= total + dng.InstancePlacements.Count) {
                    total += dng.InstancePlacements.Count;
                    continue;
                }
                int local = index - total;
                var lb = $"0x{dng.LandblockKey:X4}";
                dng.InstancePlacements.RemoveAt(local);
                // F163: persist the mutation (direct List edit raises no Update event).
                dng.ForceSave();
                return new PlacementRemoveResult(true, kind, index, lb);
            }
            return new PlacementRemoveResult(false, kind, index, null);
        }

        throw new ArgumentException($"Unknown kind '{kind}'. Expected outdoor|dungeon.");
    }

    /// <summary>
    /// E1 (wave-2) PR3 — set the enrichment export SCOPE on one placement (the Option A vs Option B
    /// switch, SPEC §3.4). <paramref name="scope"/> is "classdefault" (world weenie_properties_*) or
    /// "placementoverride" (shard biota_properties_*). Persists the change.
    /// </summary>
    public PlacementSetScopeResult PlacementSetScope(string kind, int index, string scope) {
        RequireProject();
        var project = _projectManager.CurrentProject!;

        EnrichmentScope parsed = scope.Trim().ToLowerInvariant() switch {
            "classdefault" or "class" or "a" or "world" => EnrichmentScope.ClassDefault,
            "placementoverride" or "override" or "b" or "shard" => EnrichmentScope.PlacementOverride,
            _ => throw new ArgumentException($"Unknown scope '{scope}'. Expected classDefault|placementOverride."),
        };

        if (kind.Equals("outdoor", StringComparison.OrdinalIgnoreCase)) {
            if (index < 0 || index >= project.OutdoorInstancePlacements.Count)
                return new PlacementSetScopeResult(false, kind, index, parsed.ToString());
            project.OutdoorInstancePlacements[index].Scope = parsed;
            project.Save();
            return new PlacementSetScopeResult(true, kind, index, parsed.ToString());
        }

        if (kind.Equals("dungeon", StringComparison.OrdinalIgnoreCase)) {
            // F164: reject a negative global index explicitly (parity with the outdoor path).
            if (index < 0) return new PlacementSetScopeResult(false, kind, index, parsed.ToString());
            int total = 0;
            // F164: walk the SAME deterministically-ordered doc sequence placement-list reports.
            foreach (var dng in OrderedDungeonDocs(project)) {
                if (index >= total + dng.InstancePlacements.Count) {
                    total += dng.InstancePlacements.Count;
                    continue;
                }
                dng.InstancePlacements[index - total].Scope = parsed;
                // F163: persist the mutation (direct List edit raises no Update event).
                dng.ForceSave();
                return new PlacementSetScopeResult(true, kind, index, parsed.ToString());
            }
            return new PlacementSetScopeResult(false, kind, index, parsed.ToString());
        }

        throw new ArgumentException($"Unknown kind '{kind}'. Expected outdoor|dungeon.");
    }

    public async Task<PlacementExportSqlResult> PlacementExportSqlAsync(
        string outDir, bool apply, bool dryRun = false, bool force = false, bool validate = true) {
        RequireProject();
        Directory.CreateDirectory(outDir);
        var project = _projectManager.CurrentProject!;

        // E1 (wave-2) PR2: --dry-run is a file-emit-only path. It writes the generated SQL
        // (including the new per-class enrichment tables) and NEVER touches a live ACE DB —
        // so it is mutually exclusive with --apply.
        if (dryRun) apply = false;

        // E1 (wave-2) PR1: build the addressable source-of-truth set. The export Scope rides on each
        // placement model (PR3); ClassDefault → world weenie_properties_*, PlacementOverride → shard
        // biota_properties_*. Keep a back-reference to the source model so a MINTED guid can be
        // written back onto it (stable addressable key across sessions/round-trips).
        // F165: load EVERY persisted dungeon_ doc before building the source-of-truth set, else a
        // dungeon placement persisted in an earlier session is silently OMITTED from the SQL export.
        EnsureAllDungeonDocsLoaded(project);

        var enriched = new List<EnrichedPlacement>();
        var sourceOutdoor = new Dictionary<EnrichedPlacement, OutdoorInstancePlacement>();
        var sourceDungeon = new Dictionary<EnrichedPlacement, DungeonInstancePlacement>();
        foreach (var p in project.OutdoorInstancePlacements) {
            var e = EnrichedPlacementStore.FromOutdoor(p);
            sourceOutdoor[e] = p;
            enriched.Add(e);
        }
        foreach (var (_, doc) in project.DocumentManager.ActiveDocs) {
            if (doc is not DungeonDocument dng) continue;
            foreach (var p in dng.InstancePlacements) {
                var e = EnrichedPlacementStore.FromDungeon(dng.LandblockKey, p);
                sourceDungeon[e] = p;
                enriched.Add(e);
            }
        }

        var outdoorPath = Path.Combine(outDir, "landblock_instances.sql");
        var dungeonPath = Path.Combine(outDir, "dungeon_instances.sql");
        var enrichedPath = Path.Combine(outDir, EnrichedPlacementStore.FileName);

        // E1 (wave-2) PR2: GENERATE the per-class (Option A) world-DB enrichment SQL. Pure file-emit;
        // NEVER connects to a live DB.
        var (bundle, enrichmentPaths, manifestPath) =
            EnrichmentSqlExporter.WriteFiles(outDir, enriched);

        // E1 (wave-2) PR3 / E6: OFFLINE validation gate. Runs BEFORE guid minting / world+biota
        // emission + before any apply, against the in-memory WeenieIndex (no live DB — SPEC §6).
        // Errors BLOCK the apply / biota emission unless --force; a validation_report.jsonl sidecar is
        // always written when validation is enabled. On --apply we additionally treat an un-ingested
        // index as a BLOCKING error (a live write must not skip wcid/type resolution).
        string? validationReportPath = null;
        int validationErrors = 0, validationWarnings = 0;
        bool validationBlocked = false;
        if (validate) {
            var report = EnrichedPlacementValidator.Validate(enriched, WeenieIndex, applying: apply);
            validationReportPath = EnrichedPlacementValidator.WriteReport(outDir, report);
            validationErrors = report.ErrorCount;
            validationWarnings = report.WarningCount;
            if (!report.Ok && !force) {
                // Hard gate: errors present and no --force → do NOT mint guids, emit biota SQL, or
                // apply anything. Still write the world placement directives + JSONL (harmless file
                // emits with NO minted guids) so the operator can inspect what would have shipped.
                validationBlocked = true;
                var (vOutdoorRecords, vOutdoorSql, vDungeonSql, vDungeonCount) =
                    WritePlacementDirectives(project, outdoorPath, dungeonPath);
                EnrichedPlacementStore.WriteFile(outDir, enriched);
                return new PlacementExportSqlResult(false,
                    outdoorPath, vOutdoorRecords,
                    dungeonPath, vDungeonCount,
                    null,
                    enrichedPath, enriched.Count,
                    dryRun,
                    enrichmentPaths,
                    manifestPath,
                    bundle.Conflicts.Count,
                    bundle.PlacementOverrideSkipped,
                    BiotaSqlPaths: null,
                    BiotaManifestPath: null,
                    BiotaCount: 0,
                    BiotaMintedGuids: 0,
                    BiotaWarningCount: 0,
                    BiotaSkipped: 0,
                    ValidationReportPath: validationReportPath,
                    ValidationErrorCount: validationErrors,
                    ValidationWarningCount: validationWarnings,
                    ValidationBlocked: true,
                    ShardRowsAppliedToDb: null);
            }
        }

        // F167: MINT a STATIC, per-landblock guid for EVERY placement that doesn't already carry one —
        // not just the Option-B (PlacementOverride) ones. Without this, a ClassDefault placement falls
        // through GenerateInsertSql's guid==0 branch and gets a FRESH RANDOM guid on every export (no
        // DELETE prefix), so re-applying duplicates the spawn AND the random guid lands outside the LB
        // static window (defeating ACE static addressing / Option-B joins). Minting all guids here makes
        // every landblock_instance row idempotent (static guid ⇒ GenerateInsertSql emits DELETE+INSERT)
        // and stable across re-exports. Seeds `used` from already-minted project guids and, on --apply,
        // from the live DB's existing landblock_instance guids for each touched landblock.
        // F169: on dryRun, mint into the in-memory EnrichedPlacement copies ONLY — pass empty source
        // maps so NO minted guid is written back onto the project models and the project is NOT saved.
        // A preview must never permanently mutate the project JSON.
        var mintOutdoor = dryRun ? new Dictionary<EnrichedPlacement, OutdoorInstancePlacement>() : sourceOutdoor;
        var mintDungeon = dryRun ? new Dictionary<EnrichedPlacement, DungeonInstancePlacement>() : sourceDungeon;
        await MintStaticGuidsForAllPlacementsAsync(project, enriched, mintOutdoor, mintDungeon, apply);

        // E1 (wave-2) PR3: MINT/THREAD the per-placement (Option B) static guids — Build writes each
        // resolved guid back onto its source EnrichedPlacement.Guid. Option-B placements already carry
        // their static guid from the F167 pass above, so Build threads (not re-allocates) them. This
        // must happen BEFORE the world landblock_instance SQL + the JSONL are written so (a)
        // landblock_instance.guid == biota.id (the world↔shard join ACE uses, WorldObjectFactory.cs:297)
        // and (b) the minted guid is recorded in placements_enriched.jsonl and is STABLE across
        // re-exports. The WeenieIndex resolves each override's real WeenieType (an Undef stub would
        // vanish on load).
        var (biotaBundle, biotaPaths, biotaManifestPath) =
            BiotaEnrichmentSqlExporter.WriteFiles(outDir, enriched, WeenieIndex);
        int biotaCount = biotaBundle.Biota?.BiotaCount ?? 0;
        int biotaMinted = biotaBundle.Assignments.Count(a => a.Minted);

        // Propagate the minted/threaded guids back onto the live placement models so the editor
        // session keeps the stable addressable key (and a project Save persists it).
        // F169: skip the write-back + Save entirely on dryRun (a preview must not persist minted guids).
        bool anyMinted = false;
        if (!dryRun) {
            foreach (var e in enriched) {
                if (e.Guid is not { } g) continue;
                if (sourceOutdoor.TryGetValue(e, out var op) && op.Guid != g) { op.Guid = g; anyMinted = true; }
                if (sourceDungeon.TryGetValue(e, out var dp) && dp.Guid != g) { dp.Guid = g; anyMinted = true; }
            }
            if (anyMinted) project.Save();
        }

        // Now write the world placement directives — they carry the threaded guids (PR3) — and the
        // JSONL (which records the minted guids). The JSONL is written AFTER minting so the recorded
        // guid is the stable one.
        var (outdoorRecordCount, outdoorSql, dungeonSql, dungeonCount2) =
            WritePlacementDirectives(project, outdoorPath, dungeonPath);
        EnrichedPlacementStore.WriteFile(outDir, enriched);

        int? rowsApplied = null;
        int? shardRowsApplied = null;
        if (apply) {
            // Pure, DB-free routing: WORLD scripts (placements + per-class) vs SHARD scripts (biota
            // override), kept SEPARATE (HARD CONSTRAINT 3, never crossed).
            var plan = EnrichmentApplyPlan.Build(outdoorSql, outdoorRecordCount, dungeonSql, dungeonCount2,
                bundle, biotaBundle);

            // Validate ALL preconditions BEFORE opening any transaction so a missing shard config
            // cannot leave a half-applied (world-committed, shard-skipped) live DB.
            var settings = project.AceDb;
            if (settings == null || string.IsNullOrEmpty(settings.Host))
                throw new InvalidOperationException("--apply requires ace-db connect to be configured first.");

            AceDbSettings? shard = null;
            if (plan.RequiresShard) {
                shard = project.AceShardDb;
                if (shard == null || string.IsNullOrEmpty(shard.Host))
                    throw new InvalidOperationException(
                        "--apply has Option B per-placement biota overrides but no SHARD DB is configured. " +
                        "Configure ace-shard-db connect (separate from ace-db / world) before applying biota overrides.");
                // HARD CONSTRAINT 3: the shard target must NOT resolve to the same Server+Database as
                // the world, or biota rows would land in the world DB.
                if (SameTarget(settings, shard))
                    throw new InvalidOperationException(
                        "--apply shard DB resolves to the SAME Server+Database as the world DB; biota overrides would be " +
                        "written to the world DB. Point ace-shard-db at a distinct shard database (e.g. ace_shard).");
            }

            // World (per-class Option A + the placement directives) → AceDb (WORLD).
            using var connector = new AceDbConnector(settings);
            rowsApplied = await connector.ExecuteScriptsTransactionalAsync(plan.WorldScripts);

            // Per-placement biota override (Option B) → AceShardDb (SHARD, separate connection).
            // SAFETY GATE: ACE static biotas are FULL self-contained snapshots — CreateWorldObject(biota)
            // builds the object purely from the stored biota rows with NO weenie merge (BiotaConverter).
            // Option B emits the DIVERGING facets (palette/generator/position + dye int/float) over a
            // minted stub PLUS the Option-B BASE COPY: the base weenie's Setup DID (biota_properties_d_i_d
            // type=1) and Name (biota_properties_string type=1), resolved OFFLINE from the WeenieIndex.
            // The Setup DID is the increment that makes the static object RENDERABLE — without it the
            // server fails to spawn it ("Unable to find object_id 00000000 in Portal"). A FULL base-weenie
            // property copy (all ints/floats/strings/positions) still needs the full weenie record (live
            // DB) and stays DEFERRED, so a live shard apply remains opt-in behind --force (the object now
            // renders, but other base properties are still absent); the file-emit is always safe to inspect.
            if (plan.RequiresShard) {
                if (!force)
                    throw new InvalidOperationException(
                        "--apply Option B (per-placement biota override) writes a biota carrying the diverging facets + the " +
                        "base Setup DID and Name (copied offline from the WeenieIndex, so the object renders) over a minted " +
                        "stub. A FULL base-weenie property copy (all ints/floats/strings/positions) still needs the live " +
                        "weenie record and stays DEFERRED, so the object's other base properties remain absent. The biota*.sql " +
                        "file-emit is written for inspection; pass --force to apply the override to the live shard anyway, or " +
                        "wait for full base-weenie→biota minting.");
                using var shardConnector = new AceDbConnector(shard!);
                shardRowsApplied = await shardConnector.ExecuteScriptsTransactionalAsync(plan.ShardScripts);
            }
        }

        return new PlacementExportSqlResult(true,
            outdoorPath, outdoorRecordCount,
            dungeonPath, dungeonCount2,
            rowsApplied,
            enrichedPath, enriched.Count,
            dryRun,
            enrichmentPaths,
            manifestPath,
            bundle.Conflicts.Count,
            bundle.PlacementOverrideSkipped,
            BiotaSqlPaths: biotaPaths,
            BiotaManifestPath: biotaManifestPath,
            BiotaCount: biotaCount,
            BiotaMintedGuids: biotaMinted,
            BiotaWarningCount: biotaBundle.Warnings.Count,
            BiotaSkipped: biotaBundle.Skipped,
            ValidationReportPath: validationReportPath,
            ValidationErrorCount: validationErrors,
            ValidationWarningCount: validationWarnings,
            ValidationBlocked: validationBlocked,
            ShardRowsAppliedToDb: shardRowsApplied);
    }

    /// <summary>
    /// F167 — mint a STATIC, per-landblock guid for every placement that doesn't already carry a valid
    /// static one, writing the minted guid back onto BOTH the <see cref="EnrichedPlacement"/> and its
    /// source model so every landblock_instance row is addressable + idempotent (DELETE+INSERT). The
    /// per-landblock allocator is seeded with already-minted project guids and, on <paramref name="apply"/>,
    /// with the live DB's existing landblock_instance guids for each touched landblock so a fresh mint
    /// never collides with a row already in the world DB.
    /// </summary>
    private async Task MintStaticGuidsForAllPlacementsAsync(
        WorldBuilder.Shared.Models.Project project,
        List<EnrichedPlacement> enriched,
        Dictionary<EnrichedPlacement, OutdoorInstancePlacement> sourceOutdoor,
        Dictionary<EnrichedPlacement, DungeonInstancePlacement> sourceDungeon,
        bool apply) {

        // Per-landblock "used" guid sets, seeded with every placement guid already valid for its LB so
        // a mint fills the gaps around hand-assigned / previously-minted addressable keys.
        var usedByLandblock = new Dictionary<ushort, HashSet<uint>>();
        HashSet<uint> Used(ushort lb) =>
            usedByLandblock.TryGetValue(lb, out var s) ? s : (usedByLandblock[lb] = new HashSet<uint>());

        foreach (var e in enriched) {
            if (e.Guid is { } g && StaticGuidAllocator.IsInLandblockStaticRange(e.Landblock, g))
                Used(e.Landblock).Add(g);
        }

        // On --apply, also reserve every guid already present in the live world DB for each landblock
        // we are about to touch, so a re-export against an already-populated DB mints into free slots.
        if (apply) {
            var settings = project.AceDb;
            if (settings != null && !string.IsNullOrEmpty(settings.Host)) {
                using var connector = new AceDbConnector(settings);
                foreach (var lb in enriched.Select(e => e.Landblock).Distinct()) {
                    try {
                        var existing = await connector.GetInstancesAsync(lb, includeAngles: false);
                        foreach (var rec in existing)
                            if (StaticGuidAllocator.IsInLandblockStaticRange(lb, rec.Guid))
                                Used(lb).Add(rec.Guid);
                    } catch {
                        // Best-effort: a query failure (table absent / perms) must not block file emit.
                    }
                }
            }
        }

        // Mint for any placement lacking a valid static guid; thread the result back to the source model.
        bool mutatedOutdoor = false;
        var mutatedDungeonDocs = new HashSet<DungeonDocument>();
        var dungeonByPlacement = BuildDungeonDocLookup(project);
        foreach (var e in enriched) {
            if (e.Guid is { } existing && StaticGuidAllocator.IsInLandblockStaticRange(e.Landblock, existing))
                continue;
            uint minted = StaticGuidAllocator.Allocate(e.Landblock, Used(e.Landblock));
            e.Guid = minted;
            if (sourceOutdoor.TryGetValue(e, out var op)) { op.Guid = minted; mutatedOutdoor = true; }
            if (sourceDungeon.TryGetValue(e, out var dp)) {
                dp.Guid = minted;
                if (dungeonByPlacement.TryGetValue(dp, out var dng)) mutatedDungeonDocs.Add(dng);
            }
        }

        // Persist the minted addressable keys so they're stable across sessions/re-exports: outdoor
        // placements ride the project JSON (project.Save), dungeon placements ride their document
        // (ForceSave raises the Update event the DocumentManager batch-persists).
        if (mutatedOutdoor) project.Save();
        foreach (var dng in mutatedDungeonDocs) dng.ForceSave();
    }

    /// <summary>Maps each dungeon InstancePlacement back to its owning DungeonDocument (F167 persistence).</summary>
    private static Dictionary<DungeonInstancePlacement, DungeonDocument> BuildDungeonDocLookup(
        WorldBuilder.Shared.Models.Project project) {
        var map = new Dictionary<DungeonInstancePlacement, DungeonDocument>(ReferenceEqualityComparer.Instance);
        foreach (var (_, doc) in project.DocumentManager.ActiveDocs) {
            if (doc is not DungeonDocument dng) continue;
            foreach (var p in dng.InstancePlacements) map[p] = dng;
        }
        return map;
    }

    /// <summary>
    /// Generate + write the (unchanged-shape) placement directive SQL files (landblock_instances.sql,
    /// dungeon_instances.sql) from the CURRENT placement models — which by this point carry any
    /// minted/threaded PR3 guids. Returns (outdoorCount, outdoorSql, dungeonSql, dungeonCount).
    /// </summary>
    private (int OutdoorCount, string OutdoorSql, string DungeonSql, int DungeonCount) WritePlacementDirectives(
        WorldBuilder.Shared.Models.Project project, string outdoorPath, string dungeonPath) {
        // F168: target the CONFIGURED world DB, not the hardcoded literal `ace_world`, so the
        // landblock_instance INSERTs and the enrichment SQL hit the SAME database.
        string db = project.AceDb?.Database is { Length: > 0 } d ? d : "ace_world";
        var outdoorRecords = AceDbConnector.ToLandblockInstanceRecordsFromOutdoor(project.OutdoorInstancePlacements);
        var outdoorSql = AceDbConnector.GenerateInsertSqlBatch(outdoorRecords, db);
        File.WriteAllText(outdoorPath, outdoorSql);

        int dungeonCount = 0;
        var dungeonSqlBuilder = new System.Text.StringBuilder();
        dungeonSqlBuilder.AppendLine("-- ACME WorldBuilder: dungeon instance placements (per-LB landblock_instance rows)");
        dungeonSqlBuilder.AppendLine();
        foreach (var (_, doc) in project.DocumentManager.ActiveDocs) {
            if (doc is not DungeonDocument dng) continue;
            if (dng.InstancePlacements.Count == 0) continue;
            var records = AceDbConnector.ToLandblockInstanceRecords(dng.LandblockKey, dng.InstancePlacements);
            dungeonSqlBuilder.AppendLine($"-- Landblock 0x{dng.LandblockKey:X4} ({records.Count} placements)");
            dungeonSqlBuilder.AppendLine(AceDbConnector.GenerateInsertSqlBatch(records, db));
            dungeonCount += records.Count;
        }
        var dungeonSql = dungeonSqlBuilder.ToString();
        File.WriteAllText(dungeonPath, dungeonSql);
        return (outdoorRecords.Count, outdoorSql, dungeonSql, dungeonCount);
    }

    /// <summary>True when two ACE DB settings resolve to the same Server+Port+Database (world↔shard collision guard).</summary>
    private static bool SameTarget(AceDbSettings a, AceDbSettings b) =>
        string.Equals(a.Host, b.Host, StringComparison.OrdinalIgnoreCase)
        && a.Port == b.Port
        && string.Equals(a.Database, b.Database, StringComparison.OrdinalIgnoreCase);
}
