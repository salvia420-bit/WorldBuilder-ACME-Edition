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

    public async Task<PlacementExportSqlResult> PlacementExportSqlAsync(string outDir, bool apply) {
        RequireProject();
        Directory.CreateDirectory(outDir);
        var project = _projectManager.CurrentProject!;

        var outdoorRecords = AceDbConnector.ToLandblockInstanceRecordsFromOutdoor(project.OutdoorInstancePlacements);
        var outdoorSql = AceDbConnector.GenerateInsertSqlBatch(outdoorRecords);
        var outdoorPath = Path.Combine(outDir, "landblock_instances.sql");
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
        var dungeonPath = Path.Combine(outDir, "dungeon_instances.sql");
        File.WriteAllText(dungeonPath, dungeonSql);

        int? rowsApplied = null;
        if (apply) {
            var settings = project.AceDb;
            if (settings == null || string.IsNullOrEmpty(settings.Host))
                throw new InvalidOperationException("--apply requires ace-db connect to be configured first.");
            using var connector = new AceDbConnector(settings);
            int n = 0;
            if (outdoorRecords.Count > 0) n += await connector.ExecuteSqlAsync(outdoorSql);
            if (dungeonCount > 0) n += await connector.ExecuteSqlAsync(dungeonSql);
            rowsApplied = n;
        }

        return new PlacementExportSqlResult(true,
            outdoorPath, outdoorRecords.Count,
            dungeonPath, dungeonCount,
            rowsApplied);
    }
}
