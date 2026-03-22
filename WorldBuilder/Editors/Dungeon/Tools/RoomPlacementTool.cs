using Avalonia.Input;
using CommunityToolkit.Mvvm.ComponentModel;
using DatReaderWriter.Types;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Numerics;
using WorldBuilder.Editors.Landscape;
using WorldBuilder.Lib;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Editors.Dungeon.Tools {

    /// <summary>
    /// Room/prefab placement tool. Handles both single rooms and multi-cell prefabs.
    /// Shows a ghost preview snapping to the nearest open portal. Click places.
    /// Stays active for repeated placement.
    /// </summary>
    public partial class RoomPlacementTool : DungeonToolBase {
        public override string Name => "Place Room";
        public override string IconGlyph => "\u25A3";

        private static readonly ObservableCollection<DungeonSubToolBase> _empty = new();
        public override ObservableCollection<DungeonSubToolBase> AllSubTools => _empty;

        [ObservableProperty] private RoomEntry? _pendingRoom;
        [ObservableProperty] private DungeonPrefab? _pendingPrefab;

        public event Action? CancelRequested;

        public override void OnActivated() { UpdateStatus(); }

        public override void OnDeactivated() {
            _pendingRoom = null;
            _pendingPrefab = null;
            StatusText = "";
            _lastPreviewSnappedToPortal = false;
        }

        public void SetRoom(RoomEntry room) {
            _pendingRoom = room;
            _pendingPrefab = null;
            UpdateStatus();
        }

        public void SetPrefab(DungeonPrefab prefab) {
            _pendingPrefab = prefab;
            _pendingRoom = null;
            UpdateStatus();
        }

        private void UpdateStatus() {
            if (_pendingPrefab != null) {
                var name = !string.IsNullOrEmpty(_pendingPrefab.DisplayName)
                    ? _pendingPrefab.DisplayName : $"Prefab ({_pendingPrefab.Cells.Count} cells)";
                StatusText = $"Click to place '{name}' — Escape to cancel";
            }
            else if (_pendingRoom != null) {
                StatusText = $"Click to place '{_pendingRoom.DisplayName}' — Escape to cancel";
            }
            else {
                StatusText = "Select a room or prefab from the catalog";
            }
        }

        public override bool HandleMouseDown(MouseState mouseState, DungeonEditingContext ctx) {
            if (!mouseState.LeftPressed || mouseState.RightPressed) return false;
            if (ctx.Document == null || ctx.Dats == null) return false;

            // Prefab placement
            if (_pendingPrefab != null) {
                var ray = ctx.ComputeRay(mouseState);
                if (ray != null) {
                    if (ctx.Document.Cells.Count == 0) {
                        PlacePrefabAtOrigin(ctx, ray.Value.origin, ray.Value.direction);
                    }
                    else {
                        TrySnapPrefab(ctx, ray.Value.origin, ray.Value.direction);
                    }
                }
                return true;
            }

            // Single room placement
            if (_pendingRoom != null) {
                var ray = ctx.ComputeRay(mouseState);
                if (ray != null) {
                    if (ctx.Document.Cells.Count == 0) {
                        PlaceFirstCell(ctx, ray.Value.origin, ray.Value.direction);
                    }
                    else {
                        TrySnapToPortal(ctx, ray.Value.origin, ray.Value.direction);
                    }
                }
                return true;
            }
            return false;
        }

        public override bool HandleMouseUp(MouseState mouseState, DungeonEditingContext ctx) => false;

        public override bool HandleMouseMove(MouseState mouseState, DungeonEditingContext ctx) {
            if (ctx.Scene == null) return false;
            if (_pendingRoom == null && _pendingPrefab == null) return false;

            var ray = ctx.ComputeRay(mouseState);
            if (ray == null) {
                ctx.Scene.ClearPreview();
                ctx.Scene.RoomPlacementPreview = null;
                return false;
            }

            // Compute snap position
            var snapResult = ComputePreviewForAny(ctx, ray.Value.origin, ray.Value.direction);
            if (snapResult == null) {
                ctx.Scene.ClearPreview();
                ctx.Scene.RoomPlacementPreview = null;
                return false;
            }

            var (snapOrigin, snapRot) = snapResult.Value;

            ctx.Scene.PreviewIsSnapped = _lastPreviewSnappedToPortal;

            // Build textured preview for prefabs
            if (_pendingPrefab != null && _pendingPrefab.Cells.Count > 0) {
                var previewCells = ctx.BuildPrefabEnvCells(_pendingPrefab, snapOrigin, snapRot);
                if (previewCells.Count > 0) {
                    ctx.Scene.PreviewEnvCells = previewCells;
                    ctx.Scene.RoomPlacementPreview = null;
                }
                return false;
            }

            // Single room: build a textured EnvCell preview + wireframe overlay
            if (_pendingRoom != null) {
                var surfaces = ctx.GetSurfacesForRoom(_pendingRoom);
                var envCell = new DatReaderWriter.DBObjs.EnvCell {
                    Id = 0xFFFE0100,
                    EnvironmentId = _pendingRoom.EnvironmentId,
                    CellStructure = _pendingRoom.CellStructureIndex,
                    Position = new DatReaderWriter.Types.Frame {
                        Origin = snapOrigin,
                        Orientation = snapRot
                    }
                };
                envCell.Surfaces.AddRange(surfaces);
                ctx.Scene.PreviewEnvCells = new List<DatReaderWriter.DBObjs.EnvCell> { envCell };

                ctx.Scene.RoomPlacementPreview = new RoomPlacementPreviewData {
                    Origin = snapOrigin,
                    Orientation = snapRot,
                    EnvFileId = _pendingRoom.EnvironmentFileId,
                    CellStructIndex = _pendingRoom.CellStructureIndex
                };
            }
            return false;
        }

        /// <summary>
        /// Compute preview position for either a single room or the first cell of a prefab.
        /// Tries portal snapping first; falls back to projecting the mouse ray onto a
        /// horizontal plane so the ghost always follows the cursor.
        /// Also sets the highlighted portal on the scene for visual feedback.
        /// </summary>
        private (Vector3 Origin, Quaternion Orientation)? ComputePreviewForAny(
            DungeonEditingContext ctx, Vector3 rayOrigin, Vector3 rayDir) {

            if (ctx.Document == null || ctx.Dats == null) return null;

            _lastPreviewSnappedToPortal = false;

            // Clear portal highlight
            if (ctx.Scene != null) {
                ctx.Scene.HighlightedPortalCellNum = 0;
                ctx.Scene.HighlightedPortalPolyId = 0;
            }

            if (ctx.Document.Cells.Count > 0) {
                var snapped = TryComputePortalSnap(ctx, rayOrigin, rayDir);
                if (snapped != null) {
                    _lastPreviewSnappedToPortal = true;
                    return snapped;
                }
            }

            float planeZ = 0f;
            if (ctx.Document.Cells.Count > 0)
                planeZ = ctx.Document.Cells.Average(c => c.Origin.Z);

            var hit = RayHitHorizontalPlane(rayOrigin, rayDir, planeZ);
            return hit.HasValue ? (hit.Value, Quaternion.Identity) : null;
        }

        private bool _lastPreviewSnappedToPortal;

        /// <summary>Try to snap to the nearest open portal. Uses adjacency index when available.</summary>
        private (Vector3 Origin, Quaternion Orientation)? TryComputePortalSnap(
            DungeonEditingContext ctx, Vector3 rayOrigin, Vector3 rayDir) {

            var bestCell = FindNearestOpenPortalCell(ctx, rayOrigin, rayDir);
            if (bestCell == null) return null;

            var (targetDocCell, targetCellStruct, openPortalId, _) = bestCell.Value;

            // Highlight the target portal so the user can see where connection will happen
            if (ctx.Scene != null) {
                ctx.Scene.HighlightedPortalCellNum = targetDocCell.CellNumber;
                ctx.Scene.HighlightedPortalPolyId = openPortalId;
            }

            ushort srcEnvId, srcCellStruct;
            if (_pendingPrefab != null && _pendingPrefab.Cells.Count > 0) {
                srcEnvId = _pendingPrefab.Cells[0].EnvId;
                srcCellStruct = _pendingPrefab.Cells[0].CellStruct;
            }
            else if (_pendingRoom != null) {
                srcEnvId = _pendingRoom.EnvironmentId;
                srcCellStruct = _pendingRoom.CellStructureIndex;
            }
            else return null;

            // Try adjacency index first: use proven transform from real dungeons
            if (ctx.PortalIndex != null) {
                var match = ctx.PortalIndex.FindMatch(
                    targetDocCell.EnvironmentId, targetDocCell.CellStructure, openPortalId,
                    srcEnvId, srcCellStruct);
                if (match != null) {
                    var newOrigin = targetDocCell.Origin + Vector3.Transform(match.RelOffset, targetDocCell.Orientation);
                    var newOri = Quaternion.Normalize(targetDocCell.Orientation * match.RelRot);
                    return (newOrigin, newOri);
                }
            }

            // Fall back to geometric snap
            var targetPortalLocal = PortalSnapper.GetPortalGeometry(targetCellStruct, openPortalId);
            if (targetPortalLocal == null) return null;

            var (centroidW, normalW) = PortalSnapper.TransformPortalToWorld(
                targetPortalLocal.Value, targetDocCell.Origin, targetDocCell.Orientation);

            uint srcEnvFileId = (uint)(srcEnvId | 0x0D000000);
            if (!ctx.Dats.TryGet<DatReaderWriter.DBObjs.Environment>(srcEnvFileId, out var srcEnv)) return null;
            if (!srcEnv.Cells.TryGetValue(srcCellStruct, out var srcCS)) return null;

            var srcPortalId = PortalSnapper.PickBestSourcePortal(srcCS, normalW);
            if (srcPortalId == null) return null;
            var srcGeom = PortalSnapper.GetPortalGeometry(srcCS, srcPortalId.Value);
            if (srcGeom == null) return null;

            // Check portal geometry compatibility if cache is available
            if (ctx.GeometryCache != null && srcPortalId.HasValue) {
                if (!ctx.GeometryCache.AreCompatible(
                    targetDocCell.EnvironmentId, targetDocCell.CellStructure, openPortalId,
                    srcEnvId, srcCellStruct, srcPortalId.Value)) {
                    return null;
                }
            }

            return PortalSnapper.ComputeSnapTransform(centroidW, normalW, srcGeom.Value);
        }

        private static Vector3? RayHitHorizontalPlane(Vector3 rayOrigin, Vector3 rayDir, float planeZ) {
            if (MathF.Abs(rayDir.Z) < 1e-6f) return null;
            float t = (planeZ - rayOrigin.Z) / rayDir.Z;
            if (t < 0) return null;
            return rayOrigin + rayDir * t;
        }

        public override bool HandleKeyDown(KeyEventArgs e, DungeonEditingContext ctx) {
            if (e.Key == Key.Escape) {
                if (ctx.Scene != null) {
                    ctx.Scene.RoomPlacementPreview = null;
                    ctx.Scene.ClearPreview();
                    ctx.Scene.HighlightedPortalCellNum = 0;
                    ctx.Scene.HighlightedPortalPolyId = 0;
                }
                CancelRequested?.Invoke();
                return true;
            }
            return false;
        }

        // ── Single room placement ───────────────────────────────────────

        private void PlaceFirstCell(DungeonEditingContext ctx, Vector3 rayOrigin, Vector3 rayDir) {
            if (_pendingRoom == null || ctx.Document == null) return;
            var origin = RayHitHorizontalPlane(rayOrigin, rayDir, 0f) ?? Vector3.Zero;
            var surfaces = ctx.GetSurfacesForRoom(_pendingRoom);
            var cmd = new AddCellCommand(
                _pendingRoom.EnvironmentId, _pendingRoom.CellStructureIndex,
                origin, Quaternion.Identity, surfaces);
            ctx.CommandHistory.Execute(cmd, ctx.Document);
            ctx.RefreshRendering();
            ctx.RequestCameraFocus();
            ctx.SetStatus($"{ctx.Document.Cells.Count} cells — click to place next, or pick another room");
        }

        private void TrySnapToPortal(DungeonEditingContext ctx, Vector3 rayOrigin, Vector3 rayDir) {
            if (_pendingRoom == null || ctx.Document == null || ctx.Dats == null) return;

            var bestCell = FindNearestOpenPortalCell(ctx, rayOrigin, rayDir);
            if (bestCell == null) { StatusText = "No open doorways — disconnect a doorway first"; return; }

            var (targetDocCell, targetCellStruct, openPortalId, targetCellNum) = bestCell.Value;
            var targetName = GetCellName(ctx, targetCellNum);

            if (ctx.PortalIndex != null) {
                var match = ctx.PortalIndex.FindMatch(
                    targetDocCell.EnvironmentId, targetDocCell.CellStructure, openPortalId,
                    _pendingRoom.EnvironmentId, _pendingRoom.CellStructureIndex);
                if (match != null) {
                    var idxOrigin = targetDocCell.Origin + Vector3.Transform(match.RelOffset, targetDocCell.Orientation);
                    var idxOri = Quaternion.Normalize(targetDocCell.Orientation * match.RelRot);
                    var idxSurfaces = ctx.GetSurfacesForRoom(_pendingRoom);
                    var idxCmd = new AddCellCommand(
                        _pendingRoom.EnvironmentId, _pendingRoom.CellStructureIndex,
                        idxOrigin, idxOri, idxSurfaces,
                        connectToCellNum: targetCellNum, connectToPolyId: openPortalId, sourcePolyId: match.PolyId);
                    ctx.CommandHistory.Execute(idxCmd, ctx.Document);
                    ctx.RefreshRendering();
                    ctx.SetStatus($"{ctx.Document.Cells.Count} cells — connected to {targetName}");
                    return;
                }
            }

            // Fall back to geometric snap
            var targetPortalLocal = PortalSnapper.GetPortalGeometry(targetCellStruct, openPortalId);
            if (targetPortalLocal == null) return;

            var (centroidW, normalW) = PortalSnapper.TransformPortalToWorld(
                targetPortalLocal.Value, targetDocCell.Origin, targetDocCell.Orientation);

            uint srcEnvFileId = (uint)(_pendingRoom.EnvironmentId | 0x0D000000);
            if (!ctx.Dats.TryGet<DatReaderWriter.DBObjs.Environment>(srcEnvFileId, out var srcEnv)) return;
            if (!srcEnv.Cells.TryGetValue(_pendingRoom.CellStructureIndex, out var srcCS)) return;

            var srcPortalId = PortalSnapper.PickBestSourcePortal(srcCS, normalW);
            if (srcPortalId == null) { StatusText = "No matching portal face"; return; }
            var srcGeom = PortalSnapper.GetPortalGeometry(srcCS, srcPortalId.Value);
            if (srcGeom == null) return;

            var (newOrigin, newOri) = PortalSnapper.ComputeSnapTransform(centroidW, normalW, srcGeom.Value);
            var surfaces = ctx.GetSurfacesForRoom(_pendingRoom);
            var cmd = new AddCellCommand(
                _pendingRoom.EnvironmentId, _pendingRoom.CellStructureIndex,
                newOrigin, newOri, surfaces,
                connectToCellNum: targetCellNum, connectToPolyId: openPortalId, sourcePolyId: srcPortalId.Value);
            ctx.CommandHistory.Execute(cmd, ctx.Document);
            ctx.RefreshRendering();
            ctx.SetStatus($"{ctx.Document.Cells.Count} cells — connected to {targetName}");
        }

        // ── Prefab placement ────────────────────────────────────────────

        private void PlacePrefabAtOrigin(DungeonEditingContext ctx, Vector3 rayOrigin, Vector3 rayDir) {
            if (_pendingPrefab == null || ctx.Document == null || ctx.Dats == null) return;

            var composite = new DungeonCompositeCommand("Place Prefab");
            var origin = RayHitHorizontalPlane(rayOrigin, rayDir, 0f) ?? Vector3.Zero;
            var first = _pendingPrefab.Cells[0];

            var firstCmd = new AddCellCommand(first.EnvId, first.CellStruct,
                origin, Quaternion.Identity, first.Surfaces.ToList());
            firstCmd.Execute(ctx.Document);
            composite.Add(firstCmd);

            var cellMap = new Dictionary<int, ushort> { [0] = firstCmd.CreatedCellNum };
            PlaceRemainingPrefabCells(ctx, _pendingPrefab, cellMap, composite);

            ctx.CommandHistory.Record(composite);
            ctx.RefreshRendering();
            ctx.RequestCameraFocus();
            ctx.SetStatus($"{ctx.Document.Cells.Count} cells — pick another piece from catalog");
        }

        private void TrySnapPrefab(DungeonEditingContext ctx, Vector3 rayOrigin, Vector3 rayDir) {
            if (_pendingPrefab == null || ctx.Document == null || ctx.Dats == null) return;

            var bestCell = FindNearestOpenPortalCell(ctx, rayOrigin, rayDir);
            if (bestCell == null) { StatusText = "No open doorways — disconnect a doorway first"; return; }

            var (targetDocCell, targetCellStruct, openPortalId, targetCellNum) = bestCell.Value;
            var targetGeom = PortalSnapper.GetPortalGeometry(targetCellStruct, openPortalId);
            if (targetGeom == null) return;

            var (targetCentroid, targetNormal) = PortalSnapper.TransformPortalToWorld(
                targetGeom.Value, targetDocCell.Origin, targetDocCell.Orientation);

            foreach (var openFace in _pendingPrefab.OpenFaces) {
                var prefabCell = _pendingPrefab.Cells[openFace.CellIndex];
                uint pfEnvFileId = (uint)(prefabCell.EnvId | 0x0D000000);
                if (!ctx.Dats.TryGet<DatReaderWriter.DBObjs.Environment>(pfEnvFileId, out var pfEnv)) continue;
                if (!pfEnv.Cells.TryGetValue(prefabCell.CellStruct, out var pfCS)) continue;

                var srcGeom = PortalSnapper.GetPortalGeometry(pfCS, openFace.PolyId);
                if (srcGeom == null) continue;

                var (snapOrigin, snapRot) = PortalSnapper.ComputeSnapTransform(
                    targetCentroid, targetNormal, srcGeom.Value);

                var composite = new DungeonCompositeCommand("Snap Prefab");

                var connectCmd = new AddCellCommand(prefabCell.EnvId, prefabCell.CellStruct,
                    snapOrigin, snapRot, prefabCell.Surfaces.ToList(),
                    connectToCellNum: targetCellNum, connectToPolyId: openPortalId, sourcePolyId: openFace.PolyId);
                connectCmd.Execute(ctx.Document);
                composite.Add(connectCmd);

                var cellMap = new Dictionary<int, ushort> { [openFace.CellIndex] = connectCmd.CreatedCellNum };
                PlaceRemainingPrefabCells(ctx, _pendingPrefab, cellMap, composite);

                ctx.CommandHistory.Record(composite);
                ctx.RefreshRendering();
                ctx.RequestCameraFocus();
                var tgtName = GetCellName(ctx, targetCellNum);
                ctx.SetStatus($"{ctx.Document.Cells.Count} cells — connected to {tgtName}");
                return;
            }

            StatusText = "Could not attach piece — no compatible doorway";
        }

        private void PlaceRemainingPrefabCells(DungeonEditingContext ctx, DungeonPrefab prefab,
            Dictionary<int, ushort> cellMap, DungeonCompositeCommand composite) {

            if (ctx.Document == null) return;

            int baseIdx = cellMap.Keys.First();
            var baseCellNum = cellMap[baseIdx];
            var baseDoc = ctx.Document.GetCell(baseCellNum);
            if (baseDoc == null) return;

            var basePC = prefab.Cells[baseIdx];
            var baseOffset = new Vector3(basePC.OffsetX, basePC.OffsetY, basePC.OffsetZ);
            var baseRelRot = Quaternion.Normalize(new Quaternion(basePC.RotX, basePC.RotY, basePC.RotZ, basePC.RotW));

            Quaternion invBaseRelRot = baseRelRot.LengthSquared() > 0.01f ? Quaternion.Inverse(baseRelRot) : Quaternion.Identity;
            var worldBaseRot = Quaternion.Normalize(baseDoc.Orientation * invBaseRelRot);
            var worldBaseOrigin = baseDoc.Origin - Vector3.Transform(baseOffset, worldBaseRot);

            for (int i = 0; i < prefab.Cells.Count; i++) {
                if (cellMap.ContainsKey(i)) continue;

                var pc = prefab.Cells[i];
                var offset = new Vector3(pc.OffsetX, pc.OffsetY, pc.OffsetZ);
                var relRot = Quaternion.Normalize(new Quaternion(pc.RotX, pc.RotY, pc.RotZ, pc.RotW));

                var worldOrigin = worldBaseOrigin + Vector3.Transform(offset, worldBaseRot);
                var worldRot = Quaternion.Normalize(worldBaseRot * relRot);

                var cmd = new AddCellCommand(pc.EnvId, pc.CellStruct,
                    worldOrigin, worldRot, pc.Surfaces.ToList());
                cmd.Execute(ctx.Document);
                composite.Add(cmd);
                cellMap[i] = cmd.CreatedCellNum;
            }

            foreach (var ip in prefab.InternalPortals) {
                if (cellMap.TryGetValue(ip.CellIndexA, out var cellA) && cellMap.TryGetValue(ip.CellIndexB, out var cellB)) {
                    var cmd = new ConnectPortalCommand(cellA, ip.PolyIdA, cellB, ip.PolyIdB);
                    cmd.Execute(ctx.Document);
                    composite.Add(cmd);
                }
            }
        }

        // ── Shared helpers ──────────────────────────────────────────────

        private (Vector3 Origin, Quaternion Orientation)? ComputePreview(
            DungeonEditingContext ctx, Vector3 rayOrigin, Vector3 rayDir, RoomEntry room) {

            if (ctx.Document == null || ctx.Dats == null) return null;
            if (ctx.Document.Cells.Count == 0) return (Vector3.Zero, Quaternion.Identity);

            var bestCell = FindNearestOpenPortalCell(ctx, rayOrigin, rayDir);
            if (bestCell == null) return null;

            var (targetDocCell, targetCellStruct, openPortalId, _) = bestCell.Value;
            var targetPortalLocal = PortalSnapper.GetPortalGeometry(targetCellStruct, openPortalId);
            if (targetPortalLocal == null) return null;

            var (centroidW, normalW) = PortalSnapper.TransformPortalToWorld(
                targetPortalLocal.Value, targetDocCell.Origin, targetDocCell.Orientation);

            uint srcEnvFileId = room.EnvironmentFileId;
            if (!ctx.Dats.TryGet<DatReaderWriter.DBObjs.Environment>(srcEnvFileId, out var srcEnv)) return null;
            if (!srcEnv.Cells.TryGetValue(room.CellStructureIndex, out var srcCS)) return null;

            var srcPortalId = PortalSnapper.PickBestSourcePortal(srcCS, normalW);
            if (srcPortalId == null) return null;
            var srcGeom = PortalSnapper.GetPortalGeometry(srcCS, srcPortalId.Value);
            if (srcGeom == null) return null;

            return PortalSnapper.ComputeSnapTransform(centroidW, normalW, srcGeom.Value);
        }

        internal static (DungeonCellData cell, CellStruct cellStruct, ushort portalId, ushort cellNum)?
            FindNearestOpenPortalCell(DungeonEditingContext ctx, Vector3 rayOrigin, Vector3 rayDir) {

            if (ctx.Document == null || ctx.Dats == null) return null;

            var hit = ctx.Scene?.EnvCellManager?.Raycast(rayOrigin, rayDir);
            var open = new List<(DungeonCellData dc, CellStruct cs, ushort portalId, ushort cellNum, Vector3 centroid)>();

            foreach (var dc in ctx.Document.Cells) {
                uint envFileId = (uint)(dc.EnvironmentId | 0x0D000000);
                if (!ctx.Dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) continue;
                if (!env.Cells.TryGetValue(dc.CellStructure, out var cs)) continue;

                var allPortals = PortalSnapper.GetPortalPolygonIds(cs);
                var connected = new HashSet<ushort>(dc.CellPortals.Select(cp => cp.PolygonId));
                foreach (var pid in allPortals) {
                    if (connected.Contains(pid)) continue;
                    var geom = PortalSnapper.GetPortalGeometry(cs, pid);
                    if (geom == null) continue;
                    var (centroid, _) = PortalSnapper.TransformPortalToWorld(geom.Value, dc.Origin, dc.Orientation);
                    open.Add((dc, cs, pid, dc.CellNumber, centroid));
                }
            }

            if (open.Count == 0) return null;

            if (hit != null && hit.Value.Hit) {
                var hitPos = hit.Value.HitPosition;
                var hitCellId = hit.Value.Cell.CellId;
                var hitCellNum = (ushort)(hitCellId & 0xFFFF);

                // Prefer open portals on the cell the user is actually hovering
                var onHoveredCell = open.Where(p => p.cellNum == hitCellNum).ToList();
                if (onHoveredCell.Count > 0) {
                    var nearest = onHoveredCell.OrderBy(p => (p.centroid - hitPos).LengthSquared()).First();
                    return (nearest.dc, nearest.cs, nearest.portalId, nearest.cellNum);
                }

                // Fall back to nearest open portal to the hit point
                var nearestAll = open.OrderBy(p => (p.centroid - hitPos).LengthSquared()).First();
                return (nearestAll.dc, nearestAll.cs, nearestAll.portalId, nearestAll.cellNum);
            }

            // No geometry hit -- pick nearest to ray
            float bestDist = float.MaxValue;
            (DungeonCellData dc, CellStruct cs, ushort portalId, ushort cellNum, Vector3 centroid)? best = null;
            foreach (var p in open) {
                var toPoint = p.centroid - rayOrigin;
                var proj = Vector3.Dot(toPoint, rayDir);
                if (proj < 0) continue;
                var closest = rayOrigin + rayDir * proj;
                var dist = (p.centroid - closest).LengthSquared();
                if (dist < bestDist) { bestDist = dist; best = p; }
            }
            return best.HasValue ? (best.Value.dc, best.Value.cs, best.Value.portalId, best.Value.cellNum) : null;
        }

        private static string GetCellName(DungeonEditingContext ctx, ushort cellNum) {
            var dc = ctx.Document?.GetCell(cellNum);
            if (dc == null) return $"Cell 0x{cellNum:X4}";
            uint envFileId = (uint)(dc.EnvironmentId | 0x0D000000);
            var name = ctx.RoomPalette?.GetRoomDisplayName(envFileId, dc.CellStructure);
            return !string.IsNullOrEmpty(name) ? name : $"Cell 0x{cellNum:X4}";
        }
    }
}
