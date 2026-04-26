using Avalonia.Input;
using CommunityToolkit.Mvvm.ComponentModel;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Numerics;
using WorldBuilder.Editors.Landscape.Commands;
using WorldBuilder.Lib;
using WorldBuilder.Lib.History;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Editors.Landscape.ViewModels {
    public partial class SelectorToolViewModel : ToolViewModelBase {
        public override string Name => "Select";
        public override string IconGlyph => "🎯";

        private readonly TerrainEditingContext _context;
        private readonly CommandHistory _commandHistory;

        [ObservableProperty]
        private ObservableCollection<SubToolViewModelBase> _subTools = new();

        public override ObservableCollection<SubToolViewModelBase> AllSubTools => SubTools;

        private List<(ushort LbKey, int Index, Vector3 OrigPos, Quaternion OrigRot, Vector3 OrigScale)> _gizmoDragEntries = new();
        private Vector3 _gizmoCenterAtDragStart;
        private Vector3 _gizmoTerrainDragStart;

        public SelectorToolViewModel(
            TerrainEditingContext context,
            CommandHistory commandHistory,
            SelectSubToolViewModel selectSubTool,
            MoveObjectSubToolViewModel moveSubTool,
            RotateObjectSubToolViewModel rotateSubTool,
            ScaleObjectSubToolViewModel scaleSubTool,
            CloneSubToolViewModel cloneSubTool,
            PasteSubToolViewModel pasteSubTool) {
            _context = context;
            _commandHistory = commandHistory;
            SubTools.Add(selectSubTool);
            SubTools.Add(moveSubTool);
            SubTools.Add(rotateSubTool);
            SubTools.Add(scaleSubTool);
            SubTools.Add(cloneSubTool);
            SubTools.Add(pasteSubTool);
        }

        private TransformGizmo? Gizmo => _context.TerrainSystem.Scene?._gizmo;

        public override void OnActivated() {
            SelectedSubTool?.OnActivated();
        }

        public override void OnDeactivated() {
            _context.ObjectSelection.IsPlacementMode = false;
            _context.ObjectSelection.PlacementPreview = null;
            Gizmo?.CancelDrag();
            SelectedSubTool?.OnDeactivated();
        }

        public override bool HandleMouseDown(MouseState mouseState) {
            if (mouseState.LeftPressed) {
                var gizmo = Gizmo;
                var sel = _context.ObjectSelection;
                if (gizmo != null && sel.HasSelection && !sel.HasEnvCellSelection && !sel.IsPlacementMode && sel.HasEditableEntry) {
                    var camera = _context.TerrainSystem.Scene.CameraManager.Current;
                    var vp = camera.GetViewMatrix() * camera.GetProjectionMatrix();
                    var (center, orientation) = GetGizmoTransform();

                    var axis = gizmo.HitTestScreen(mouseState.Position, camera, vp, center, orientation);
                    if (axis != GizmoAxis.None) {
                        var entries = sel.SelectedEntries
                            .Where(e => !e.IsScenery && e.ObjectIndex >= 0)
                            .Select(e => (e.LandblockKey, e.ObjectIndex, e.Object.Origin, e.Object.Orientation, e.Object.Scale))
                            .ToList();
                        if (entries.Count > 0) {
                            gizmo.StartDrag(axis, mouseState.Position, camera, vp, center, orientation);
                            _gizmoCenterAtDragStart = center;
                            _gizmoTerrainDragStart = mouseState.TerrainHit?.HitPosition ?? center;
                            _gizmoDragEntries = entries;
                            return true;
                        }
                    }
                }
            }
            return SelectedSubTool?.HandleMouseDown(mouseState) ?? false;
        }

        public override bool HandleMouseUp(MouseState mouseState) {
            var gizmo = Gizmo;
            if (gizmo != null && gizmo.IsDragging) {
                FinalizeGizmoDrag();
                gizmo.EndDrag();
                return true;
            }
            return SelectedSubTool?.HandleMouseUp(mouseState) ?? false;
        }

        public override bool HandleMouseMove(MouseState mouseState) {
            var gizmo = Gizmo;
            if (gizmo != null) {
                if (gizmo.IsDragging) {
                    var camera = _context.TerrainSystem.Scene.CameraManager.Current;
                    ApplyGizmoDrag(mouseState, camera);
                    return true;
                }

                var sel = _context.ObjectSelection;
                if (sel.HasSelection && !sel.HasEnvCellSelection && !sel.IsPlacementMode && sel.HasEditableEntry) {
                    var camera = _context.TerrainSystem.Scene.CameraManager.Current;
                    var vp = camera.GetViewMatrix() * camera.GetProjectionMatrix();
                    var (center, orientation) = GetGizmoTransform();
                    gizmo.UpdateHover(mouseState.Position, camera, vp, center, orientation);
                }
            }
            return SelectedSubTool?.HandleMouseMove(mouseState) ?? false;
        }

        public override bool HandleKeyDown(KeyEventArgs e) {
            var gizmo = Gizmo;
            if (gizmo != null) {
                switch (e.Key) {
                    case Key.W:
                        gizmo.Mode = GizmoMode.Translate;
                        return true;
                    case Key.E:
                        gizmo.Mode = GizmoMode.Rotate;
                        return true;
                    case Key.R:
                        gizmo.Mode = GizmoMode.Scale;
                        return true;
                }
            }
            return SelectedSubTool?.HandleKeyDown(e) ?? false;
        }

        public override void Update(double deltaTime) {
            SelectedSubTool?.Update(deltaTime);
        }

        private (Vector3 center, Quaternion orientation) GetGizmoTransform() {
            var entries = _context.ObjectSelection.SelectedEntries;
            var center = Vector3.Zero;
            foreach (var e in entries) center += e.Object.Origin;
            center /= entries.Count;
            var orientation = entries.Count == 1 ? entries[0].Object.Orientation : Quaternion.Identity;
            return (center, orientation);
        }

        private void ApplyGizmoDrag(MouseState mouseState, ICamera camera) {
            var gizmo = Gizmo;
            if (gizmo == null || _gizmoDragEntries.Count == 0) return;

            var snapSettings = _context.TerrainSystem.Settings.Landscape.Snap;

            if (gizmo.Mode == GizmoMode.Translate) {
                Vector3 delta;

                if (mouseState.IsOverTerrain && mouseState.TerrainHit.HasValue) {
                    delta = mouseState.TerrainHit.Value.HitPosition - _gizmoTerrainDragStart;
                } else {
                    delta = gizmo.ComputeTranslateDelta(mouseState.Position, camera, _gizmoCenterAtDragStart);
                }

                var axis = gizmo.ActiveAxis;
                if (axis == GizmoAxis.X) delta = new Vector3(delta.X, 0, 0);
                else if (axis == GizmoAxis.Y) delta = new Vector3(0, delta.Y, 0);
                else if (axis == GizmoAxis.Z) delta = new Vector3(0, 0, delta.Z);
                else if (axis == GizmoAxis.XY) delta.Z = 0;
                else if (axis == GizmoAxis.XZ) delta.Y = 0;
                else if (axis == GizmoAxis.YZ) delta.X = 0;

                if (snapSettings.SnapToGrid && snapSettings.GridSize > 0) {
                    float g = snapSettings.GridSize;
                    delta.X = MathF.Round(delta.X / g) * g;
                    delta.Y = MathF.Round(delta.Y / g) * g;
                }

                foreach (var (lbKey, index, origPos, _, _) in _gizmoDragEntries) {
                    var newPos = origPos + delta;

                    if (axis != GizmoAxis.Z) {
                        float terrainZ = _context.GetHeightAtPosition(newPos.X, newPos.Y);
                        if (snapSettings.SnapToTerrain) {
                            newPos.Z = terrainZ;
                        } else {
                            float origOffset = origPos.Z - _context.GetHeightAtPosition(origPos.X, origPos.Y);
                            newPos.Z = terrainZ + origOffset;
                        }
                    }

                    UpdateObjectInDocument(lbKey, index, pos: newPos);
                }
            }
            else if (gizmo.Mode == GizmoMode.Rotate) {
                float angle = gizmo.ComputeRotationAngle(mouseState.Position, camera, _gizmoCenterAtDragStart);

                if (snapSettings.SnapRotation && snapSettings.RotationIncrement > 0) {
                    float incRad = snapSettings.RotationIncrement * MathF.PI / 180f;
                    angle = MathF.Round(angle / incRad) * incRad;
                }

                var axisDir = gizmo.GetRotationAxisDirection();
                var rotation = Quaternion.CreateFromAxisAngle(axisDir, angle);

                foreach (var (lbKey, index, origPos, origRot, _) in _gizmoDragEntries) {
                    var offset = origPos - _gizmoCenterAtDragStart;
                    var rotatedOffset = Vector3.Transform(offset, rotation);
                    var newPos = _gizmoCenterAtDragStart + rotatedOffset;
                    var newRot = Quaternion.Normalize(rotation * origRot);

                    UpdateObjectInDocument(lbKey, index, pos: newPos, rot: newRot);
                }
            }
            else if (gizmo.Mode == GizmoMode.Scale) {
                var scaleDelta = gizmo.ComputeScaleDelta(mouseState.Position, camera, _gizmoCenterAtDragStart);

                foreach (var (lbKey, index, _, _, origScale) in _gizmoDragEntries) {
                    var newScale = origScale + origScale * scaleDelta;
                    newScale = Vector3.Max(newScale, new Vector3(0.01f));
                    UpdateObjectInDocument(lbKey, index, scale: newScale);
                }
            }

            _context.ObjectSelection.RefreshAllFromDocuments(docId =>
                _context.TerrainSystem.DocumentManager.GetOrCreateDocumentAsync<LandblockDocument>(docId).GetAwaiter().GetResult());
            _context.TerrainSystem.Scene.InvalidateStaticObjectsCache();
        }

        private void UpdateObjectInDocument(ushort lbKey, int index,
            Vector3? pos = null, Quaternion? rot = null, Vector3? scale = null) {
            var docId = $"landblock_{lbKey:X4}";
            var doc = _context.TerrainSystem.DocumentManager
                .GetOrCreateDocumentAsync<LandblockDocument>(docId).GetAwaiter().GetResult();
            if (doc == null || index >= doc.StaticObjectCount) return;
            var obj = doc.GetStaticObject(index);
            doc.UpdateStaticObject(index, new StaticObject {
                Id = obj.Id,
                IsSetup = obj.IsSetup,
                Origin = pos ?? obj.Origin,
                Orientation = rot ?? obj.Orientation,
                Scale = scale ?? obj.Scale
            });
        }

        private void FinalizeGizmoDrag() {
            var gizmo = Gizmo;
            if (gizmo == null || _gizmoDragEntries.Count == 0) return;

            var commands = new List<ICommand>();
            foreach (var (lbKey, index, origPos, origRot, origScale) in _gizmoDragEntries) {
                var docId = $"landblock_{lbKey:X4}";
                var doc = _context.TerrainSystem.DocumentManager
                    .GetOrCreateDocumentAsync<LandblockDocument>(docId).GetAwaiter().GetResult();
                if (doc == null || index >= doc.StaticObjectCount) continue;
                var curr = doc.GetStaticObject(index);

                if (gizmo.Mode == GizmoMode.Translate) {
                    if (Vector3.Distance(curr.Origin, origPos) >= 0.01f)
                        commands.Add(new MoveObjectCommand(_context, lbKey, index, origPos, curr.Origin));
                }
                else if (gizmo.Mode == GizmoMode.Rotate) {
                    if (Vector3.Distance(curr.Origin, origPos) >= 0.01f)
                        commands.Add(new MoveObjectCommand(_context, lbKey, index, origPos, curr.Origin));
                    if (curr.Orientation != origRot)
                        commands.Add(new RotateObjectCommand(_context, lbKey, index, origRot, curr.Orientation));
                }
                else if (gizmo.Mode == GizmoMode.Scale) {
                    if (Vector3.Distance(curr.Scale, origScale) >= 0.001f)
                        commands.Add(new ScaleObjectCommand(_context, lbKey, index, origScale, curr.Scale));
                }
            }

            if (commands.Count > 0) {
                if (commands.Count == 1)
                    _commandHistory.ExecuteCommand(commands[0]);
                else
                    _commandHistory.ExecuteCommand(new CompoundCommand($"Gizmo {gizmo.Mode}", commands));
            }

            if (gizmo.Mode == GizmoMode.Translate)
                SyncBuildingCells();

            _gizmoDragEntries.Clear();
        }

        private void SyncBuildingCells() {
            var dats = _context.TerrainSystem.Dats;
            var envMgr = _context.TerrainSystem.Scene?._envCellManager;
            if (dats == null || envMgr == null) return;

            foreach (var (lbKey, index, origPos, _, _) in _gizmoDragEntries) {
                var docId = $"landblock_{lbKey:X4}";
                var doc = _context.TerrainSystem.DocumentManager
                    .GetOrCreateDocumentAsync<LandblockDocument>(docId).GetAwaiter().GetResult();
                if (doc == null || index >= doc.StaticObjectCount) continue;

                var obj = doc.GetStaticObject(index);
                if (!BuildingBlueprintCache.IsBuildingModelId(obj.Id, dats)) continue;

                var delta = obj.Origin - origPos;
                if (delta.LengthSquared() < 0.001f) continue;

                uint infoId = ((uint)lbKey << 16) | 0xFFFE;
                if (!dats.TryGet<DatReaderWriter.DBObjs.LandBlockInfo>(infoId, out var lbi)) continue;
                if (lbi.Buildings == null) continue;

                var cellMap = LandblockDocument.GetCellToBuildingMap(lbi, dats, (uint)lbKey);
                foreach (var kvp in cellMap) {
                    if (kvp.Value.ModelId != obj.Id) continue;

                    uint fullCellId = ((uint)lbKey << 16) | kvp.Key;
                    var loadedCell = envMgr.FindCell(fullCellId);
                    if (loadedCell == null) continue;

                    loadedCell.WorldPosition += delta;
                    var wt = loadedCell.WorldTransform;
                    wt.M41 += delta.X;
                    wt.M42 += delta.Y;
                    wt.M43 += delta.Z;
                    loadedCell.WorldTransform = wt;

                    if (Matrix4x4.Invert(wt, out var inv))
                        loadedCell.InverseWorldTransform = inv;
                }
            }
        }
    }
}
