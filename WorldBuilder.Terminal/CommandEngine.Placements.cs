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
            foreach (var (_, doc) in project.DocumentManager.ActiveDocs) {
                if (doc is not DungeonDocument dng) continue;
                if (lbKey.HasValue && dng.LandblockKey != lbKey.Value) continue;
                for (int i = 0; i < dng.InstancePlacements.Count; i++) {
                    var p = dng.InstancePlacements[i];
                    dungeon.Add(new PlacementListRow(
                        Kind: "dungeon",
                        Index: i,
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
            AnglesW = angW ?? 0f, AnglesX = angX ?? 0f,
            AnglesY = angY ?? 0f, AnglesZ = angZ ?? 1f,
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
            Orientation = new Quaternion(angX ?? 0f, angY ?? 0f, angZ ?? 1f, angW ?? 0f),
        };
        dng.InstancePlacements.Add(p);
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
            int total = 0;
            foreach (var (_, doc) in project.DocumentManager.ActiveDocs) {
                if (doc is not DungeonDocument dng) continue;
                if (index >= total + dng.InstancePlacements.Count) {
                    total += dng.InstancePlacements.Count;
                    continue;
                }
                int local = index - total;
                var lb = $"0x{dng.LandblockKey:X4}";
                dng.InstancePlacements.RemoveAt(local);
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
            int total = 0;
            foreach (var (_, doc) in project.DocumentManager.ActiveDocs) {
                if (doc is not DungeonDocument dng) continue;
                if (index >= total + dng.InstancePlacements.Count) {
                    total += dng.InstancePlacements.Count;
                    continue;
                }
                dng.InstancePlacements[index - total].Scope = parsed;
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

        // E1 (wave-2) PR3: MINT/THREAD the per-placement (Option B) static guids FIRST — Build writes
        // each resolved guid back onto its source EnrichedPlacement.Guid. This must happen BEFORE the
        // world landblock_instance SQL + the JSONL are written so (a) landblock_instance.guid ==
        // biota.id (the world↔shard join ACE uses, WorldObjectFactory.cs:297) and (b) the minted guid
        // is recorded in placements_enriched.jsonl and is STABLE across re-exports. The WeenieIndex
        // resolves each override's real WeenieType (an Undef stub would vanish on load).
        var (biotaBundle, biotaPaths, biotaManifestPath) =
            BiotaEnrichmentSqlExporter.WriteFiles(outDir, enriched, WeenieIndex);
        int biotaCount = biotaBundle.Biota?.BiotaCount ?? 0;
        int biotaMinted = biotaBundle.Assignments.Count(a => a.Minted);

        // Propagate the minted/threaded guids back onto the live placement models so the editor
        // session keeps the stable addressable key (and a project Save persists it).
        bool anyMinted = false;
        foreach (var e in enriched) {
            if (e.Guid is not { } g) continue;
            if (sourceOutdoor.TryGetValue(e, out var op) && op.Guid != g) { op.Guid = g; anyMinted = true; }
            if (sourceDungeon.TryGetValue(e, out var dp) && dp.Guid != g) { dp.Guid = g; anyMinted = true; }
        }
        if (anyMinted) project.Save();

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
    /// Generate + write the (unchanged-shape) placement directive SQL files (landblock_instances.sql,
    /// dungeon_instances.sql) from the CURRENT placement models — which by this point carry any
    /// minted/threaded PR3 guids. Returns (outdoorCount, outdoorSql, dungeonSql, dungeonCount).
    /// </summary>
    private (int OutdoorCount, string OutdoorSql, string DungeonSql, int DungeonCount) WritePlacementDirectives(
        WorldBuilder.Shared.Models.Project project, string outdoorPath, string dungeonPath) {
        var outdoorRecords = AceDbConnector.ToLandblockInstanceRecordsFromOutdoor(project.OutdoorInstancePlacements);
        var outdoorSql = AceDbConnector.GenerateInsertSqlBatch(outdoorRecords);
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
            dungeonSqlBuilder.AppendLine(AceDbConnector.GenerateInsertSqlBatch(records));
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
