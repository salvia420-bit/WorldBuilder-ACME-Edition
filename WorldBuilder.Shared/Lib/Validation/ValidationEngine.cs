using DatReaderWriter.DBObjs;
using DatReaderWriter.Types;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Dungeon;

namespace WorldBuilder.Shared.Lib.Validation;

/// <summary>
/// Severity level for validation diagnostics.
/// </summary>
public enum ValidationSeverity {
    Info,
    Warning,
    Error
}

/// <summary>
/// A single validation diagnostic with severity, code, and human-readable message.
/// </summary>
public record ValidationDiagnostic(
    ValidationSeverity Severity,
    string Code,
    string Message,
    string? Context = null);

/// <summary>
/// Full report from a validation run.
/// </summary>
public record ValidationReport(
    string CheckType,
    string Target,
    DateTime Timestamp,
    bool IsValid,
    int ErrorCount,
    int WarningCount,
    int InfoCount,
    List<ValidationDiagnostic> Diagnostics);

/// <summary>
/// Headless, UI-free validation engine for WorldBuilder data.
/// Performs "sanity checks" on geometry, portal links, terrain, objects, and dungeons
/// so that an AI agent gets immediate structured feedback after mutations.
/// </summary>
public static class ValidationEngine {
    public const float DefaultCliffThreshold = 12f;

    // ════════════════════════════════════════════════════════════
    //  Dungeon validation
    // ════════════════════════════════════════════════════════════

    /// <summary>
    /// Validates a dungeon document for structural integrity.
    /// Checks: empty dungeons, broken portal links, orphaned cells,
    /// duplicate cell numbers, invalid environment references, degenerate geometry,
    /// portal symmetry, and graph connectivity.
    /// </summary>
    public static ValidationReport ValidateDungeon(DungeonDocument dungeon, IDatReaderWriter? dats = null) {
        var diagnostics = new List<ValidationDiagnostic>();
        var target = $"dungeon_{dungeon.LandblockKey:X4}";

        // ── Empty dungeon ──
        if (dungeon.Cells.Count == 0) {
            diagnostics.Add(new(ValidationSeverity.Error, "DNG001", "Dungeon has no cells."));
            return BuildReport("dungeon", target, diagnostics);
        }

        var cellNums = new HashSet<ushort>();
        var cellMap = dungeon.Cells.ToDictionary(c => c.CellNumber);

        // ── Duplicate cell numbers ──
        foreach (var cell in dungeon.Cells) {
            if (!cellNums.Add(cell.CellNumber)) {
                diagnostics.Add(new(ValidationSeverity.Error, "DNG002",
                    $"Duplicate cell number 0x{cell.CellNumber:X4}.",
                    $"Cell 0x{cell.CellNumber:X4}"));
            }
        }

        foreach (var cell in dungeon.Cells) {
            // ── Broken portal references ──
            foreach (var portal in cell.CellPortals) {
                if (portal.OtherCellId == 0 || portal.OtherCellId == 0xFFFF) continue;

                if (!cellNums.Contains(portal.OtherCellId)) {
                    diagnostics.Add(new(ValidationSeverity.Error, "DNG003",
                        $"Cell 0x{cell.CellNumber:X4} portal references non-existent cell 0x{portal.OtherCellId:X4}.",
                        $"Cell 0x{cell.CellNumber:X4} → 0x{portal.OtherCellId:X4}"));
                }
            }

            // ── Portal symmetry check ──
            foreach (var portal in cell.CellPortals) {
                if (portal.OtherCellId == 0 || portal.OtherCellId == 0xFFFF) continue;
                if (!cellMap.TryGetValue(portal.OtherCellId, out var otherCell)) continue;

                bool hasBackLink = otherCell.CellPortals.Any(p => p.OtherCellId == cell.CellNumber);
                if (!hasBackLink) {
                    diagnostics.Add(new(ValidationSeverity.Warning, "DNG004",
                        $"Cell 0x{cell.CellNumber:X4} has a portal to 0x{portal.OtherCellId:X4} but there is no return portal.",
                        $"Cell 0x{cell.CellNumber:X4} → 0x{portal.OtherCellId:X4}"));
                }
            }

            // ── Visible cell references ──
            foreach (var vc in cell.VisibleCells) {
                if (vc >= 0x0100 && vc <= 0xFFFD && !cellNums.Contains(vc)) {
                    diagnostics.Add(new(ValidationSeverity.Warning, "DNG005",
                        $"Cell 0x{cell.CellNumber:X4} visible-cell list references non-existent cell 0x{vc:X4}.",
                        $"Cell 0x{cell.CellNumber:X4}"));
                }
            }

            // ── Invalid environment ID (if DATs available) ──
            if (dats != null) {
                uint envFileId = (uint)(cell.EnvironmentId | 0x0D000000);
                if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) {
                    diagnostics.Add(new(ValidationSeverity.Error, "DNG006",
                        $"Cell 0x{cell.CellNumber:X4} references environment 0x{envFileId:X8} which does not exist in the DAT.",
                        $"Cell 0x{cell.CellNumber:X4}"));
                } else {
                    // ── Invalid CellStructure index ──
                    if (!env.Cells.ContainsKey(cell.CellStructure)) {
                        diagnostics.Add(new(ValidationSeverity.Error, "DNG007",
                            $"Cell 0x{cell.CellNumber:X4} uses CellStructure index {cell.CellStructure} which does not exist in environment 0x{envFileId:X8}.",
                            $"Cell 0x{cell.CellNumber:X4}"));
                    } else {
                        var cellStruct = env.Cells[cell.CellStructure];

                        // ── Portal polygon validation ──
                        var availablePortalIds = PortalSnapAlgorithms.GetPortalPolygonIds(cellStruct);
                        foreach (var portal in cell.CellPortals) {
                            if (portal.PolygonId != 0 && !availablePortalIds.Contains(portal.PolygonId)) {
                                diagnostics.Add(new(ValidationSeverity.Warning, "DNG008",
                                    $"Cell 0x{cell.CellNumber:X4} portal uses polygon ID {portal.PolygonId} which is not a portal polygon in the CellStruct.",
                                    $"Cell 0x{cell.CellNumber:X4}"));
                            }
                        }

                        // ── Unconnected portals ──
                        int connectedPortalCount = cell.CellPortals.Count(p =>
                            p.OtherCellId != 0 && p.OtherCellId != 0xFFFF);
                        if (connectedPortalCount < availablePortalIds.Count) {
                            int unused = availablePortalIds.Count - connectedPortalCount;
                            diagnostics.Add(new(ValidationSeverity.Info, "DNG009",
                                $"Cell 0x{cell.CellNumber:X4} has {unused} unconnected portal(s) out of {availablePortalIds.Count} available.",
                                $"Cell 0x{cell.CellNumber:X4}"));
                        }
                    }
                }
            }

            // ── Degenerate quaternion check ──
            float qLen = cell.Orientation.Length();
            if (qLen < 0.9f || qLen > 1.1f) {
                diagnostics.Add(new(ValidationSeverity.Error, "DNG010",
                    $"Cell 0x{cell.CellNumber:X4} has a degenerate orientation quaternion (length={qLen:F4}, expected ~1.0).",
                    $"Cell 0x{cell.CellNumber:X4}"));
            }
        }

        // ── Graph connectivity: are all cells reachable from the first? ──
        if (dungeon.Cells.Count > 1) {
            var reachable = new HashSet<ushort>();
            var queue = new Queue<ushort>();
            var start = dungeon.Cells[0].CellNumber;
            reachable.Add(start);
            queue.Enqueue(start);

            while (queue.Count > 0) {
                var current = queue.Dequeue();
                if (!cellMap.TryGetValue(current, out var cell)) continue;
                foreach (var portal in cell.CellPortals) {
                    if (portal.OtherCellId != 0 && portal.OtherCellId != 0xFFFF &&
                        cellNums.Contains(portal.OtherCellId) &&
                        reachable.Add(portal.OtherCellId)) {
                        queue.Enqueue(portal.OtherCellId);
                    }
                }
            }

            var unreachable = cellNums.Except(reachable).ToList();
            if (unreachable.Count > 0) {
                diagnostics.Add(new(ValidationSeverity.Error, "DNG011",
                    $"{unreachable.Count} cell(s) are disconnected from the main dungeon graph: " +
                    string.Join(", ", unreachable.Take(10).Select(c => $"0x{c:X4}")) +
                    (unreachable.Count > 10 ? "..." : ""),
                    "Connectivity"));
            }
        }

        return BuildReport("dungeon", target, diagnostics);
    }

    // ════════════════════════════════════════════════════════════
    //  Landblock / object validation
    // ════════════════════════════════════════════════════════════

    /// <summary>
    /// Validates a landblock's static objects for common issues.
    /// Checks: objects outside landblock bounds, objects below terrain,
    /// zero-scale objects, degenerate orientations, duplicate positions.
    /// </summary>
    public static ValidationReport ValidateLandblock(
        LandblockDocument lbDoc,
        ushort lbKey,
        Func<float, float, float>? heightLookup = null,
        IDatReaderWriter? dats = null) {

        var diagnostics = new List<ValidationDiagnostic>();
        var target = $"landblock_{lbKey:X4}";

        uint lbX = (uint)(lbKey >> 8);
        uint lbY = (uint)(lbKey & 0xFF);
        float worldMinX = lbX * 192f;
        float worldMinY = lbY * 192f;
        float worldMaxX = worldMinX + 192f;
        float worldMaxY = worldMinY + 192f;

        var objects = lbDoc.GetStaticObjects().ToList();

        if (objects.Count == 0) {
            diagnostics.Add(new(ValidationSeverity.Info, "LBK001",
                "Landblock has no static objects.", target));
            return BuildReport("landblock", target, diagnostics);
        }

        var positionCounts = new Dictionary<string, int>();

        for (int i = 0; i < objects.Count; i++) {
            var obj = objects[i];
            var prefix = $"Object[{i}] 0x{obj.Id:X8}";

            // ── Bounds check ──
            if (obj.Origin.X < worldMinX - 24f || obj.Origin.X > worldMaxX + 24f ||
                obj.Origin.Y < worldMinY - 24f || obj.Origin.Y > worldMaxY + 24f) {
                diagnostics.Add(new(ValidationSeverity.Warning, "LBK002",
                    $"{prefix} is outside the landblock bounds. Position: ({obj.Origin.X:F1}, {obj.Origin.Y:F1}, {obj.Origin.Z:F1}), " +
                    $"expected within ({worldMinX}, {worldMinY}) to ({worldMaxX}, {worldMaxY}).",
                    prefix));
            }

            // ── Objects far below terrain ──
            if (heightLookup != null) {
                try {
                    float terrainH = heightLookup(obj.Origin.X, obj.Origin.Y);
                    float delta = obj.Origin.Z - terrainH;
                    if (delta < -50f) {
                        diagnostics.Add(new(ValidationSeverity.Warning, "LBK003",
                            $"{prefix} is {Math.Abs(delta):F1} units below terrain (obj Z={obj.Origin.Z:F1}, terrain Z={terrainH:F1}).",
                            prefix));
                    }
                    if (delta > 500f) {
                        diagnostics.Add(new(ValidationSeverity.Info, "LBK004",
                            $"{prefix} is {delta:F1} units above terrain — may be floating.",
                            prefix));
                    }
                } catch {
                    // Height lookup may fail for positions outside loaded terrain
                }
            }

            // ── Zero or near-zero scale ──
            if (obj.Scale.X < 0.001f || obj.Scale.Y < 0.001f || obj.Scale.Z < 0.001f) {
                diagnostics.Add(new(ValidationSeverity.Error, "LBK005",
                    $"{prefix} has near-zero scale ({obj.Scale.X:F3}, {obj.Scale.Y:F3}, {obj.Scale.Z:F3}) — will be invisible.",
                    prefix));
            }

            // ── Degenerate quaternion ──
            float qLen = obj.Orientation.Length();
            if (qLen < 0.9f || qLen > 1.1f) {
                diagnostics.Add(new(ValidationSeverity.Error, "LBK006",
                    $"{prefix} has a degenerate orientation quaternion (length={qLen:F4}).",
                    prefix));
            }

            // ── Invalid model ID (if DATs available) ──
            if (dats != null) {
                bool modelExists;
                if ((obj.Id & 0xFF000000) == 0x02000000) {
                    modelExists = dats.TryGet<Setup>(obj.Id, out _);
                } else if ((obj.Id & 0xFF000000) == 0x01000000) {
                    modelExists = dats.TryGet<GfxObj>(obj.Id, out _);
                } else {
                    modelExists = false;
                    diagnostics.Add(new(ValidationSeverity.Warning, "LBK007",
                        $"{prefix} has unexpected high byte 0x{(obj.Id >> 24):X2} — not a known GfxObj (0x01) or Setup (0x02) ID prefix.",
                        prefix));
                }

                if (!modelExists) {
                    diagnostics.Add(new(ValidationSeverity.Error, "LBK008",
                        $"{prefix} references model 0x{obj.Id:X8} which does not exist in the DAT.",
                        prefix));
                }
            }

            // ── Track duplicate positions ──
            string posKey = $"{obj.Id:X8}@{obj.Origin.X:F1},{obj.Origin.Y:F1},{obj.Origin.Z:F1}";
            positionCounts.TryGetValue(posKey, out var count);
            positionCounts[posKey] = count + 1;
        }

        // ── Report exact duplicates ──
        foreach (var kvp in positionCounts.Where(k => k.Value > 1)) {
            diagnostics.Add(new(ValidationSeverity.Warning, "LBK009",
                $"Model 0x{kvp.Key.Split('@')[0]} appears {kvp.Value} times at the same position ({kvp.Key.Split('@')[1]}).",
                "Duplicates"));
        }

        return BuildReport("landblock", target, diagnostics);
    }

    // ════════════════════════════════════════════════════════════
    //  Terrain validation
    // ════════════════════════════════════════════════════════════

    /// <summary>
    /// Validates terrain data for a landblock.
    /// Checks: extreme height cliffs between adjacent vertices, consistent terrain types,
    /// and boundary stitching issues with adjacent landblocks.
    /// </summary>
    public static ValidationReport ValidateTerrain(
        TerrainDocument terrainDoc,
        ushort lbKey,
        float[] heightTable,
        float cliffThreshold = DefaultCliffThreshold) {

        var diagnostics = new List<ValidationDiagnostic>();
        var target = $"terrain_{lbKey:X4}";

        uint lbX = (uint)(lbKey >> 8);
        uint lbY = (uint)(lbKey & 0xFF);

        var data = terrainDoc.GetLandblockInternal(lbKey);
        if (data == null) {
            diagnostics.Add(new(ValidationSeverity.Info, "TRN001",
                $"No terrain data for landblock 0x{lbKey:X4}.", target));
            return BuildReport("terrain", target, diagnostics);
        }

        // ── Height cliff detection ──
        for (int x = 0; x < 9; x++) {
            for (int y = 0; y < 9; y++) {
                int idx = x * 9 + y;
                float h = HeightAtIndex(data[idx].Height, heightTable);

                // Check right neighbor
                if (x < 8) {
                    int rightIdx = (x + 1) * 9 + y;
                    float hRight = HeightAtIndex(data[rightIdx].Height, heightTable);
                    float delta = Math.Abs(h - hRight);
                    if (delta > cliffThreshold) {
                        diagnostics.Add(new(ValidationSeverity.Warning, "TRN002",
                            $"Extreme height cliff of {delta:F1} units between vertex ({x},{y}) and ({x + 1},{y}).",
                            $"Vertex ({x},{y})"));
                    }
                }

                // Check up neighbor
                if (y < 8) {
                    int upIdx = x * 9 + (y + 1);
                    float hUp = HeightAtIndex(data[upIdx].Height, heightTable);
                    float delta = Math.Abs(h - hUp);
                    if (delta > cliffThreshold) {
                        diagnostics.Add(new(ValidationSeverity.Warning, "TRN002",
                            $"Extreme height cliff of {delta:F1} units between vertex ({x},{y}) and ({x},{y + 1}).",
                            $"Vertex ({x},{y})"));
                    }
                }
            }
        }

        // ── Boundary stitching: check edges against neighbors ──
        CheckEdgeStitching(terrainDoc, lbX, lbY, data, heightTable, diagnostics);

        // ── All same terrain type (suspicious if intentional) ──
        var types = new HashSet<byte>(data.Select(d => d.Type));
        if (types.Count == 1) {
            diagnostics.Add(new(ValidationSeverity.Info, "TRN003",
                $"All 81 vertices use terrain type {data[0].Type}. This is valid but may indicate unfinished painting.",
                target));
        }

        // ── Completely flat (all same height) ──
        var heights = new HashSet<byte>(data.Select(d => d.Height));
        if (heights.Count == 1) {
            diagnostics.Add(new(ValidationSeverity.Info, "TRN004",
                $"All 81 vertices have height index {data[0].Height} — landblock is completely flat.",
                target));
        }

        return BuildReport("terrain", target, diagnostics);
    }

    // ════════════════════════════════════════════════════════════
    //  Building portal link validation
    // ════════════════════════════════════════════════════════════

    /// <summary>
    /// Validates building portal links in a landblock's LandBlockInfo.
    /// Checks: portal targets exist as EnvCells, EnvCell CellPortals are
    /// reciprocal, and VisibleCells contain valid LandCell/EnvCell IDs.
    /// </summary>
    public static ValidationReport ValidateBuildingShells(
        ushort lbKey,
        IDatReaderWriter dats) {

        var diagnostics = new List<ValidationDiagnostic>();
        var target = $"building_shells_{lbKey:X4}";

        uint lbId = lbKey;
        uint lbiId = (lbId << 16) | 0xFFFE;

        if (!dats.TryGet<LandBlockInfo>(lbiId, out var lbi)) {
            diagnostics.Add(new(ValidationSeverity.Info, "BSH001",
                $"No LandBlockInfo for landblock 0x{lbKey:X4}.", target));
            return BuildReport("building-shells", target, diagnostics);
        }

        if (lbi.Buildings == null || lbi.Buildings.Count == 0) {
            diagnostics.Add(new(ValidationSeverity.Info, "BSH002",
                $"Landblock 0x{lbKey:X4} has no building shells.", target));
            return BuildReport("building-shells", target, diagnostics);
        }

        var duplicateCounts = new Dictionary<string, int>();

        for (int i = 0; i < lbi.Buildings.Count; i++) {
            var building = lbi.Buildings[i];
            var label = $"Building[{i}] 0x{building.ModelId:X8}";
            var origin = building.Frame.Origin;

            if (float.IsNaN(origin.X) || float.IsNaN(origin.Y) || float.IsNaN(origin.Z) ||
                float.IsInfinity(origin.X) || float.IsInfinity(origin.Y) || float.IsInfinity(origin.Z)) {
                diagnostics.Add(new(ValidationSeverity.Error, "BSH003",
                    $"{label} has invalid origin coordinates ({origin.X}, {origin.Y}, {origin.Z}).",
                    label));
                continue;
            }

            // Building frames are landblock-local. Allow small spillover for border cases.
            if (origin.X < -24f || origin.X > 216f || origin.Y < -24f || origin.Y > 216f) {
                diagnostics.Add(new(ValidationSeverity.Warning, "BSH004",
                    $"{label} is outside expected landblock-local range. Position: ({origin.X:F1}, {origin.Y:F1}, {origin.Z:F1}).",
                    label));
            }

            float qLen = building.Frame.Orientation.Length();
            if (qLen < 0.9f || qLen > 1.1f) {
                diagnostics.Add(new(ValidationSeverity.Error, "BSH005",
                    $"{label} has a degenerate orientation quaternion (length={qLen:F4}).",
                    label));
            }

            bool modelExists;
            if ((building.ModelId & 0xFF000000) == 0x01000000) {
                modelExists = dats.TryGet<GfxObj>(building.ModelId, out _);
            } else if ((building.ModelId & 0xFF000000) == 0x02000000) {
                modelExists = dats.TryGet<Setup>(building.ModelId, out _);
            } else {
                modelExists = false;
                diagnostics.Add(new(ValidationSeverity.Warning, "BSH006",
                    $"{label} has unexpected model ID prefix 0x{(building.ModelId >> 24):X2}.",
                    label));
            }

            if (!modelExists) {
                diagnostics.Add(new(ValidationSeverity.Error, "BSH007",
                    $"{label} references model 0x{building.ModelId:X8} which does not exist in DAT.",
                    label));
            }

            string dupKey = $"{building.ModelId:X8}@{origin.X:F1},{origin.Y:F1},{origin.Z:F1}";
            duplicateCounts.TryGetValue(dupKey, out var count);
            duplicateCounts[dupKey] = count + 1;
        }

        foreach (var dup in duplicateCounts.Where(kv => kv.Value > 1)) {
            diagnostics.Add(new(ValidationSeverity.Warning, "BSH008",
                $"Building shell model 0x{dup.Key.Split('@')[0]} appears {dup.Value} times at {dup.Key.Split('@')[1]}.",
                "Duplicates"));
        }

        return BuildReport("building-shells", target, diagnostics);
    }

    /// <summary>
    /// Validates interior portal links for building-connected EnvCells.
    /// This does NOT validate exterior shell visibility/model data.
    /// </summary>
    public static ValidationReport ValidateBuildingPortals(
        ushort lbKey,
        IDatReaderWriter dats) {

        var diagnostics = new List<ValidationDiagnostic>();
        var target = $"building_portals_{lbKey:X4}";

        uint lbId = lbKey;
        uint lbiId = (lbId << 16) | 0xFFFE;

        if (!dats.TryGet<LandBlockInfo>(lbiId, out var lbi)) {
            diagnostics.Add(new(ValidationSeverity.Info, "BLD001",
                $"No LandBlockInfo for landblock 0x{lbKey:X4}.", target));
            return BuildReport("building-portals", target, diagnostics);
        }

        if (lbi.Buildings == null || lbi.Buildings.Count == 0) {
            diagnostics.Add(new(ValidationSeverity.Info, "BLD002",
                $"Landblock 0x{lbKey:X4} has no buildings.", target));
            return BuildReport("building-portals", target, diagnostics);
        }

        foreach (var building in lbi.Buildings) {
            var bldgLabel = $"Building 0x{building.ModelId:X8}";

            // Check each building portal points to a valid EnvCell
            foreach (var portal in building.Portals) {
                if (portal.OtherCellId < 0x0100 || portal.OtherCellId > 0xFFFD) continue;

                uint fullCellId = (lbId << 16) | portal.OtherCellId;
                if (!dats.TryGet<EnvCell>(fullCellId, out var envCell)) {
                    diagnostics.Add(new(ValidationSeverity.Error, "BLD003",
                        $"{bldgLabel} portal targets EnvCell 0x{fullCellId:X8} which does not exist.",
                        bldgLabel));
                    continue;
                }

                // Check reciprocal: EnvCell should have a CellPortal back to the outdoor
                bool hasExteriorLink = envCell.CellPortals.Any(cp =>
                    cp.OtherCellId < 0x0100 || cp.OtherCellId == 0xFFFF);
                if (!hasExteriorLink) {
                    diagnostics.Add(new(ValidationSeverity.Warning, "BLD004",
                        $"{bldgLabel} links to EnvCell 0x{portal.OtherCellId:X4} but that cell has no outdoor exit portal.",
                        bldgLabel));
                }
            }

            // BFS: walk all cells for this building, validate internal portals
            var visitedCells = new HashSet<ushort>();
            var toVisit = new Queue<ushort>();

            foreach (var portal in building.Portals) {
                if (portal.OtherCellId >= 0x0100 && portal.OtherCellId <= 0xFFFD) {
                    if (visitedCells.Add(portal.OtherCellId))
                        toVisit.Enqueue(portal.OtherCellId);
                }
            }

            while (toVisit.Count > 0) {
                var cellNum = toVisit.Dequeue();
                uint fullId = (lbId << 16) | cellNum;

                if (!dats.TryGet<EnvCell>(fullId, out var cell)) {
                    diagnostics.Add(new(ValidationSeverity.Error, "BLD005",
                        $"{bldgLabel}: interior cell 0x{fullId:X8} does not exist in DAT.",
                        bldgLabel));
                    continue;
                }

                foreach (var cp in cell.CellPortals) {
                    if (cp.OtherCellId < 0x0100 || cp.OtherCellId > 0xFFFD) continue;

                    uint otherFullId = (lbId << 16) | cp.OtherCellId;
                    if (!dats.TryGet<EnvCell>(otherFullId, out _)) {
                        diagnostics.Add(new(ValidationSeverity.Error, "BLD006",
                            $"{bldgLabel}: cell 0x{cellNum:X4} has portal to non-existent cell 0x{cp.OtherCellId:X4}.",
                            $"{bldgLabel} → Cell 0x{cellNum:X4}"));
                    }

                    if (visitedCells.Add(cp.OtherCellId))
                        toVisit.Enqueue(cp.OtherCellId);
                }

                // Validate VisibleCells
                foreach (var vc in cell.VisibleCells) {
                    if (vc >= 0x0100 && vc <= 0xFFFD) {
                        uint vcFullId = (lbId << 16) | vc;
                        if (!dats.TryGet<EnvCell>(vcFullId, out _) && !visitedCells.Contains(vc)) {
                            diagnostics.Add(new(ValidationSeverity.Warning, "BLD007",
                                $"{bldgLabel}: cell 0x{cellNum:X4} VisibleCells references non-existent EnvCell 0x{vc:X4}.",
                                $"{bldgLabel} → Cell 0x{cellNum:X4}"));
                        }
                    } else if (vc >= 0x0001 && vc <= 0x0040) {
                        // Valid LandCell range — OK
                    } else if (vc != 0 && vc != 0xFFFF) {
                        diagnostics.Add(new(ValidationSeverity.Warning, "BLD008",
                            $"{bldgLabel}: cell 0x{cellNum:X4} VisibleCells contains unexpected ID 0x{vc:X4}.",
                            $"{bldgLabel} → Cell 0x{cellNum:X4}"));
                    }
                }
            }
        }

        return BuildReport("building-portals", target, diagnostics);
    }

    // ════════════════════════════════════════════════════════════
    //  Combined validator
    // ════════════════════════════════════════════════════════════

    /// <summary>
    /// Runs all applicable validators for a landblock in one call.
    /// Returns a combined report with diagnostics from every checker,
    /// each prefixed with its source (e.g. "[terrain] …").
    /// </summary>
    public static ValidationReport ValidateAll(
        ushort lbKey,
        DungeonDocument? dungeonDoc,
        LandblockDocument? lbDoc,
        TerrainDocument? terrainDoc,
        float[]? heightTable,
        Func<float, float, float>? heightLookup,
        IDatReaderWriter? dats,
        float cliffThreshold = DefaultCliffThreshold) {

        var allDiagnostics = new List<ValidationDiagnostic>();
        var target = $"all_{lbKey:X4}";

        // ── Dungeon ──
        if (dungeonDoc != null && dungeonDoc.Cells.Count > 0) {
            var r = ValidateDungeon(dungeonDoc, dats);
            allDiagnostics.AddRange(r.Diagnostics);
        }

        // ── Landblock objects ──
        if (lbDoc != null) {
            var r = ValidateLandblock(lbDoc, lbKey, heightLookup, dats);
            allDiagnostics.AddRange(r.Diagnostics);
        }

        // ── Terrain ──
        if (terrainDoc != null && heightTable != null) {
            var r = ValidateTerrain(terrainDoc, lbKey, heightTable, cliffThreshold);
            allDiagnostics.AddRange(r.Diagnostics);
        }

        // ── Building shells (exterior model data) ──
        if (dats != null) {
            var r = ValidateBuildingShells(lbKey, dats);
            allDiagnostics.AddRange(r.Diagnostics);
        }

        // ── Building portals (interior graph) ──
        if (dats != null) {
            var r = ValidateBuildingPortals(lbKey, dats);
            allDiagnostics.AddRange(r.Diagnostics);
        }

        return BuildReport("all", target, allDiagnostics);
    }

    // ════════════════════════════════════════════════════════════
    //  Helpers
    // ════════════════════════════════════════════════════════════

    private static ValidationReport BuildReport(
        string checkType, string target, List<ValidationDiagnostic> diagnostics) {

        int errors = diagnostics.Count(d => d.Severity == ValidationSeverity.Error);
        int warnings = diagnostics.Count(d => d.Severity == ValidationSeverity.Warning);
        int infos = diagnostics.Count(d => d.Severity == ValidationSeverity.Info);

        return new ValidationReport(
            checkType, target, DateTime.UtcNow,
            IsValid: errors == 0,
            ErrorCount: errors,
            WarningCount: warnings,
            InfoCount: infos,
            Diagnostics: diagnostics);
    }

    private static float HeightAtIndex(byte heightIndex, float[] heightTable) {
        return heightIndex < heightTable.Length ? heightTable[heightIndex] : heightIndex * 2f;
    }

    /// <summary>
    /// Checks edge stitching between a landblock and its neighbors.
    /// Adjacent landblocks must share the same height at edge vertices.
    /// </summary>
    private static void CheckEdgeStitching(
        TerrainDocument terrainDoc,
        uint lbX, uint lbY,
        TerrainEntry[] data,
        float[] heightTable,
        List<ValidationDiagnostic> diagnostics) {

        // Check right edge (x=8) vs left edge (x=0) of neighbor (lbX+1, lbY)
        if (lbX < 254) {
            ushort neighborKey = (ushort)(((lbX + 1) << 8) | lbY);
            var neighborData = terrainDoc.GetLandblockInternal(neighborKey);
            if (neighborData != null) {
                for (int y = 0; y < 9; y++) {
                    int ourIdx = 8 * 9 + y;
                    int theirIdx = 0 * 9 + y;
                    if (data[ourIdx].Height != neighborData[theirIdx].Height) {
                        diagnostics.Add(new(ValidationSeverity.Warning, "TRN005",
                            $"Edge height mismatch at Y={y}: this landblock edge height index={data[ourIdx].Height} " +
                            $"vs neighbor 0x{neighborKey:X4} edge height index={neighborData[theirIdx].Height}.",
                            $"Right edge, Y={y}"));
                    }
                }
            }
        }

        // Check top edge (y=8) vs bottom edge (y=0) of neighbor (lbX, lbY+1)
        if (lbY < 254) {
            ushort neighborKey = (ushort)((lbX << 8) | (lbY + 1));
            var neighborData = terrainDoc.GetLandblockInternal(neighborKey);
            if (neighborData != null) {
                for (int x = 0; x < 9; x++) {
                    int ourIdx = x * 9 + 8;
                    int theirIdx = x * 9 + 0;
                    if (data[ourIdx].Height != neighborData[theirIdx].Height) {
                        diagnostics.Add(new(ValidationSeverity.Warning, "TRN005",
                            $"Edge height mismatch at X={x}: this landblock edge height index={data[ourIdx].Height} " +
                            $"vs neighbor 0x{neighborKey:X4} edge height index={neighborData[theirIdx].Height}.",
                            $"Top edge, X={x}"));
                    }
                }
            }
        }
    }
}
