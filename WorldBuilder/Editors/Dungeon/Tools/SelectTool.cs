using Avalonia.Input;
using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Numerics;
using WorldBuilder.Editors.Landscape;
using WorldBuilder.Lib;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Editors.Dungeon.Tools {

    /// <summary>
    /// Unified select tool: click to select cells/objects, drag to move them.
    /// Ctrl+click for multi-select, drag in empty space for box select.
    /// Supports gizmo-based translate/rotate for selected objects.
    /// </summary>
    public class SelectTool : DungeonToolBase {
        public override string Name => "Select";
        public override string IconGlyph => "\u2B9E";

        private static readonly ObservableCollection<DungeonSubToolBase> _empty = new();
        public override ObservableCollection<DungeonSubToolBase> AllSubTools => _empty;

        private readonly DungeonEditingContext _ctx;

        private enum DragMode { None, BoxSelect, MoveCell, MoveObject, Gizmo }
        private DragMode _dragMode;
        private Vector2 _dragScreenStart;
        private Vector3 _dragWorldStart;
        private Vector3 _dragOriginStart;
        private bool _didClickSelect;
        private const float DragThreshold = 4f;
        private bool _dragStarted;

        private Vector3 _gizmoOrigPos;
        private Quaternion _gizmoOrigRot;
        private Vector3 _gizmoWorldCenter;
        private Vector3 _gizmoCellHitStart;

        public SelectTool(DungeonEditingContext ctx) {
            _ctx = ctx;
        }

        private TransformGizmo? Gizmo => _ctx.Scene?.Gizmo;

        public override void OnActivated() { StatusText = ""; }
        public override void OnDeactivated() {
            _dragMode = DragMode.None;
            Gizmo?.CancelDrag();
        }

        private Vector3 StabToWorld(Vector3 stabOrigin, DungeonDocument doc) {
            uint lbId = doc.LandblockKey;
            var blockX = (lbId >> 8) & 0xFF;
            var blockY = lbId & 0xFF;
            return stabOrigin + new Vector3(blockX * 192f, blockY * 192f, -50f);
        }

        public override bool HandleMouseDown(MouseState mouseState, DungeonEditingContext ctx) {
            if (!mouseState.LeftPressed || mouseState.RightPressed) return false;
            if (ctx.Scene?.EnvCellManager == null || ctx.Document == null) return false;

            var gizmo = Gizmo;
            if (gizmo != null && ctx.HasSelectedObject) {
                var cell = ctx.Document.GetCell(ctx.SelectedObjCellNum);
                if (cell != null && ctx.SelectedObjIndex < cell.StaticObjects.Count) {
                    var stab = cell.StaticObjects[ctx.SelectedObjIndex];
                    var worldPos = StabToWorld(stab.Origin, ctx.Document);
                    var camera = ctx.Scene.Camera;
                    var vp = camera.GetViewMatrix() * camera.GetProjectionMatrix();

                    var axis = gizmo.HitTestScreen(mouseState.Position, camera, vp, worldPos, stab.Orientation);
                    if (axis != GizmoAxis.None) {
                        gizmo.StartDrag(axis, mouseState.Position, camera, vp, worldPos, stab.Orientation);
                        _dragMode = DragMode.Gizmo;
                        _gizmoOrigPos = stab.Origin;
                        _gizmoOrigRot = stab.Orientation;
                        _gizmoWorldCenter = worldPos;

                        var startRay = ctx.ComputeRay(mouseState);
                        if (startRay.HasValue) {
                            _gizmoCellHitStart = worldPos;
                            if (ctx.Scene.EnvCellManager != null) {
                                var surfaceHit = ctx.Scene.EnvCellManager.RaycastSurface(startRay.Value.origin, startRay.Value.direction);
                                if (surfaceHit.Hit)
                                    _gizmoCellHitStart = surfaceHit.HitPosition;
                            }
                            if (_gizmoCellHitStart == worldPos) {
                                var startHit = ctx.Raycast(startRay.Value.origin, startRay.Value.direction);
                                if (startHit.Hit) _gizmoCellHitStart = startHit.HitPosition;
                            }
                        } else {
                            _gizmoCellHitStart = worldPos;
                        }
                        return true;
                    }
                }
            }

            var ray = ctx.ComputeRay(mouseState);
            if (ray == null) return false;
            var (origin, dir) = ray.Value;

            _dragScreenStart = mouseState.Position;
            _dragStarted = false;
            _didClickSelect = false;

            var objHit = DungeonObjectRaycast.Raycast(origin, dir, ctx.Document, ctx.Scene);
            if (objHit.Hit) {
                var cell = ctx.Document.GetCell(objHit.CellNumber);
                if (cell != null && objHit.ObjectIndex < cell.StaticObjects.Count) {
                    bool alreadySelected = ctx.SelectedObjCellNum == objHit.CellNumber
                                           && ctx.SelectedObjIndex == objHit.ObjectIndex;
                    ctx.SelectedObjCellNum = objHit.CellNumber;
                    ctx.SelectedObjIndex = objHit.ObjectIndex;
                    ctx.SelectedCell = null;
                    ctx.SelectedCells.Clear();
                    ctx.NotifySelectionChanged();
                    _didClickSelect = true;

                    if (alreadySelected) {
                        _dragMode = DragMode.MoveObject;
                        _dragWorldStart = objHit.HitPosition;
                        _dragOriginStart = cell.StaticObjects[objHit.ObjectIndex].Origin;
                    }
                    return true;
                }
            }

            // Check for cell hit
            var hit = ctx.Raycast(origin, dir);
            if (hit.Hit) {
                bool ctrlAdd = mouseState.CtrlPressed;
                bool wasSelected = ctx.SelectedCells.Any(c => c.CellId == hit.Cell.CellId);

                if (ctrlAdd) {
                    var idx = ctx.SelectedCells.FindIndex(c => c.CellId == hit.Cell.CellId);
                    if (idx >= 0) ctx.SelectedCells.RemoveAt(idx);
                    else ctx.SelectedCells.Add(hit.Cell);
                    ctx.SelectedCell = ctx.SelectedCells.Count > 0 ? ctx.SelectedCells[0] : null;
                }
                else if (!wasSelected) {
                    ctx.SelectedCells.Clear();
                    ctx.SelectedCells.Add(hit.Cell);
                    ctx.SelectedCell = hit.Cell;
                }
                ctx.SelectedObjIndex = -1;
                ctx.NotifySelectionChanged();
                _didClickSelect = true;

                // Allow drag-move if cell was already selected (or just became selected without ctrl)
                if (wasSelected || !ctrlAdd) {
                    var cellNum = (ushort)(hit.Cell.CellId & 0xFFFF);
                    var dc = ctx.Document.GetCell(cellNum);
                    if (dc != null) {
                        _dragMode = DragMode.MoveCell;
                        _dragWorldStart = hit.HitPosition;
                        _dragOriginStart = dc.Origin;
                    }
                }
                return true;
            }

            // Missed everything -- start box select
            _dragMode = DragMode.BoxSelect;
            _dragScreenStart = mouseState.Position;
            return false;
        }

        public override bool HandleMouseUp(MouseState mouseState, DungeonEditingContext ctx) {
            var mode = _dragMode;
            _dragMode = DragMode.None;

            if (mode == DragMode.Gizmo) {
                FinalizeGizmoDrag(ctx);
                Gizmo?.EndDrag();
                return true;
            }

            if (mode == DragMode.MoveObject && _dragStarted && ctx.Document != null) {
                var cell = ctx.Document.GetCell(ctx.SelectedObjCellNum);
                if (cell != null && ctx.SelectedObjIndex < cell.StaticObjects.Count) {
                    var delta = cell.StaticObjects[ctx.SelectedObjIndex].Origin - _dragOriginStart;
                    if (delta.LengthSquared() > 0.001f) {
                        cell.StaticObjects[ctx.SelectedObjIndex].Origin = _dragOriginStart;
                        ctx.CommandHistory.Execute(
                            new MoveStaticObjectCommand(ctx.SelectedObjCellNum, ctx.SelectedObjIndex, delta),
                            ctx.Document);
                        ctx.RefreshRendering();
                        ctx.NotifySelectionChanged();
                    }
                }
                return true;
            }

            if (mode == DragMode.MoveCell && _dragStarted && ctx.SelectedCell != null && ctx.Document != null) {
                var cellNum = (ushort)(ctx.SelectedCell.CellId & 0xFFFF);
                var dc = ctx.Document.GetCell(cellNum);
                if (dc != null) {
                    var delta = dc.Origin - _dragOriginStart;
                    if (delta.LengthSquared() > 0.001f) {
                        dc.Origin = _dragOriginStart;
                        ctx.CommandHistory.Execute(new NudgeCellCommand(cellNum, delta), ctx.Document);
                        ctx.RefreshRendering();
                    }
                }
                return true;
            }

            if (mode == DragMode.BoxSelect) {
                var endPos = mouseState.Position;
                if ((endPos - _dragScreenStart).Length() > DragThreshold) {
                    float minX = Math.Min(_dragScreenStart.X, endPos.X);
                    float maxX = Math.Max(_dragScreenStart.X, endPos.X);
                    float minY = Math.Min(_dragScreenStart.Y, endPos.Y);
                    float maxY = Math.Max(_dragScreenStart.Y, endPos.Y);

                    ctx.SelectedCells.Clear();
                    ctx.SelectedCell = null;
                    var cells = ctx.Scene?.EnvCellManager?.GetLoadedCellsForLandblock(ctx.Document.LandblockKey);
                    if (cells != null) {
                        foreach (var cell in cells) {
                            var screenPos = ProjectToScreen(cell.WorldPosition, ctx);
                            if (screenPos.X >= minX && screenPos.X <= maxX && screenPos.Y >= minY && screenPos.Y <= maxY) {
                                ctx.SelectedCells.Add(cell);
                            }
                        }
                        if (ctx.SelectedCells.Count > 0) ctx.SelectedCell = ctx.SelectedCells[0];
                    }
                    ctx.NotifySelectionChanged();
                    return true;
                }

                // Tiny drag = deselect
                ctx.SelectedCells.Clear();
                ctx.SelectedCell = null;
                ctx.SelectedObjIndex = -1;
                ctx.NotifySelectionChanged();
                return false;
            }

            return false;
        }

        public override bool HandleMouseMove(MouseState mouseState, DungeonEditingContext ctx) {
            var gizmo = Gizmo;
            if (gizmo != null) {
                if (_dragMode == DragMode.Gizmo) {
                    ApplyGizmoDrag(mouseState, ctx);
                    return true;
                }

                if (ctx.HasSelectedObject && ctx.Scene != null && ctx.Document != null && _dragMode == DragMode.None) {
                    var cell = ctx.Document.GetCell(ctx.SelectedObjCellNum);
                    if (cell != null && ctx.SelectedObjIndex < cell.StaticObjects.Count) {
                        var stab = cell.StaticObjects[ctx.SelectedObjIndex];
                        var worldPos = StabToWorld(stab.Origin, ctx.Document);
                        var camera = ctx.Scene.Camera;
                        var vp = camera.GetViewMatrix() * camera.GetProjectionMatrix();
                        gizmo.UpdateHover(mouseState.Position, camera, vp, worldPos, stab.Orientation);
                    }
                }
            }

            if (_dragMode == DragMode.BoxSelect) return true;

            float screenDist = (mouseState.Position - _dragScreenStart).Length();

            if (_dragMode == DragMode.MoveCell && ctx.SelectedCell != null && ctx.Document != null) {
                if (!_dragStarted && screenDist < DragThreshold) return false;
                _dragStarted = true;

                var ray = ctx.ComputeRay(mouseState);
                if (ray == null) return false;
                var hit = ctx.Raycast(ray.Value.origin, ray.Value.direction);
                if (!hit.Hit) return false;

                var delta = hit.HitPosition - _dragWorldStart;
                var newOrigin = _dragOriginStart + delta;
                if (ctx.GridSnapEnabled && ctx.GridSnapSize > 0.1f) {
                    newOrigin = new Vector3(
                        MathF.Round(newOrigin.X / ctx.GridSnapSize) * ctx.GridSnapSize,
                        MathF.Round(newOrigin.Y / ctx.GridSnapSize) * ctx.GridSnapSize,
                        MathF.Round(newOrigin.Z / ctx.GridSnapSize) * ctx.GridSnapSize);
                }
                var cellNum = (ushort)(ctx.SelectedCell.CellId & 0xFFFF);
                var dc = ctx.Document.GetCell(cellNum);
                if (dc != null) {
                    dc.Origin = newOrigin;
                    ctx.RefreshRendering();
                }
                return true;
            }

            if (_dragMode == DragMode.MoveObject && ctx.Document != null) {
                if (!_dragStarted && screenDist < DragThreshold) return false;
                _dragStarted = true;

                var ray = ctx.ComputeRay(mouseState);
                if (ray == null) return false;
                var hit = ctx.Raycast(ray.Value.origin, ray.Value.direction);
                if (!hit.Hit) return false;

                var cell = ctx.Document.GetCell(ctx.SelectedObjCellNum);
                if (cell != null && ctx.SelectedObjIndex < cell.StaticObjects.Count) {
                    var delta = hit.HitPosition - _dragWorldStart;
                    var newPos = _dragOriginStart + delta;
                    var worldNewPos = StabToWorld(newPos, ctx.Document);
                    if (IsInsideAnyCell(worldNewPos, ctx)) {
                        cell.StaticObjects[ctx.SelectedObjIndex].Origin = newPos;
                        ctx.RefreshRendering();
                    }
                }
                return true;
            }

            // Hover feedback
            if (ctx.Scene?.EnvCellManager == null) return false;
            var hoverRay = ctx.ComputeRay(mouseState);
            if (hoverRay == null) return false;
            var hoverHit = ctx.Raycast(hoverRay.Value.origin, hoverRay.Value.direction);
            if (hoverHit.Hit) {
                var roomName = ctx.RoomPalette?.GetRoomDisplayName(hoverHit.Cell.EnvironmentId, (ushort)hoverHit.Cell.GpuKey.CellStructure);
                var label = !string.IsNullOrEmpty(roomName) ? roomName : $"Env 0x{hoverHit.Cell.EnvironmentId:X8}";
                ctx.SetStatus($"0x{hoverHit.Cell.CellId:X8}  |  {label}");
            }
            return false;
        }

        public override bool HandleKeyDown(KeyEventArgs e, DungeonEditingContext ctx) {
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

            if (e.Key == Key.Escape) {
                if (_dragMode == DragMode.Gizmo) {
                    CancelGizmoDrag(ctx);
                    gizmo?.CancelDrag();
                    _dragMode = DragMode.None;
                    return true;
                }
                _dragMode = DragMode.None;
                ctx.SelectedCells.Clear();
                ctx.SelectedCell = null;
                ctx.SelectedObjIndex = -1;
                ctx.NotifySelectionChanged();
                return true;
            }
            return false;
        }

        private void ApplyGizmoDrag(MouseState mouseState, DungeonEditingContext ctx) {
            var gizmo = Gizmo;
            if (gizmo == null || ctx.Document == null || ctx.Scene == null) return;
            var cell = ctx.Document.GetCell(ctx.SelectedObjCellNum);
            if (cell == null || ctx.SelectedObjIndex >= cell.StaticObjects.Count) return;

            var camera = ctx.Scene.Camera;
            var stab = cell.StaticObjects[ctx.SelectedObjIndex];

            if (gizmo.Mode == GizmoMode.Translate) {
                Vector3 delta = Vector3.Zero;
                bool gotDelta = false;
                var axis = gizmo.ActiveAxis;
                Vector3 surfaceNormal = Vector3.UnitZ;
                bool hasSurfaceNormal = false;

                var ray = ctx.ComputeRay(mouseState);
                if (ray.HasValue && ctx.Scene.EnvCellManager != null) {
                    var surfaceHit = ctx.Scene.EnvCellManager.RaycastSurface(ray.Value.origin, ray.Value.direction);
                    if (surfaceHit.Hit) {
                        delta = surfaceHit.HitPosition - _gizmoCellHitStart;
                        surfaceNormal = surfaceHit.HitNormal;
                        hasSurfaceNormal = true;
                        gotDelta = true;
                    } else {
                        var hit = ctx.Raycast(ray.Value.origin, ray.Value.direction);
                        if (hit.Hit) {
                            delta = hit.HitPosition - _gizmoCellHitStart;
                            gotDelta = true;
                        }
                    }
                }

                if (!gotDelta && axis == GizmoAxis.Z) {
                    delta = gizmo.ComputeTranslateDelta(mouseState.Position, camera, _gizmoWorldCenter);
                    delta = new Vector3(0, 0, delta.Z);
                    gotDelta = true;
                }

                if (!gotDelta) return;

                if (axis == GizmoAxis.X) delta = new Vector3(delta.X, 0, 0);
                else if (axis == GizmoAxis.Y) delta = new Vector3(0, delta.Y, 0);
                else if (axis == GizmoAxis.Z) delta = new Vector3(0, 0, delta.Z);
                else if (axis == GizmoAxis.XY) delta.Z = 0;
                else if (axis == GizmoAxis.XZ) delta.Y = 0;
                else if (axis == GizmoAxis.YZ) delta.X = 0;
                else if (axis == GizmoAxis.All) { /* no constraint */ }

                if (ctx.GridSnapEnabled && ctx.GridSnapSize > 0.1f) {
                    float g = ctx.GridSnapSize;
                    delta.X = MathF.Round(delta.X / g) * g;
                    delta.Y = MathF.Round(delta.Y / g) * g;
                    delta.Z = MathF.Round(delta.Z / g) * g;
                }

                var newPos = _gizmoOrigPos + delta;
                var worldNewPos = StabToWorld(newPos, ctx.Document);
                if (IsInsideAnyCell(worldNewPos, ctx)) {
                    stab.Origin = newPos;

                    if (hasSurfaceNormal && ctx.AlignToSurface) {
                        var surfaceRot = TerrainEditingContext.AlignToNormal(surfaceNormal);
                        float yaw = ExtractYaw(_gizmoOrigRot);
                        var yawRot = Quaternion.CreateFromAxisAngle(Vector3.UnitZ, yaw);
                        stab.Orientation = Quaternion.Normalize(surfaceRot * yawRot);
                    }
                }
            }
            else if (gizmo.Mode == GizmoMode.Rotate) {
                float angle = gizmo.ComputeRotationAngle(mouseState.Position, camera, _gizmoWorldCenter);
                var axisDir = gizmo.GetRotationAxisDirection();
                var rotation = Quaternion.CreateFromAxisAngle(axisDir, angle);
                stab.Orientation = Quaternion.Normalize(rotation * _gizmoOrigRot);
            }

            ctx.Scene.SelectedObjectPosition = StabToWorld(stab.Origin, ctx.Document);
            ctx.Scene.SelectedObjectOrientation = stab.Orientation;
            ctx.RefreshRendering();
        }

        private void FinalizeGizmoDrag(DungeonEditingContext ctx) {
            var gizmo = Gizmo;
            if (gizmo == null || ctx.Document == null) return;
            var cell = ctx.Document.GetCell(ctx.SelectedObjCellNum);
            if (cell == null || ctx.SelectedObjIndex >= cell.StaticObjects.Count) return;

            var stab = cell.StaticObjects[ctx.SelectedObjIndex];
            var composite = new DungeonCompositeCommand($"Gizmo {gizmo.Mode}");
            bool hasChange = false;

            if (gizmo.Mode == GizmoMode.Translate) {
                var delta = stab.Origin - _gizmoOrigPos;
                if (delta.LengthSquared() > 0.001f) {
                    stab.Origin = _gizmoOrigPos;
                    composite.Add(new MoveStaticObjectCommand(ctx.SelectedObjCellNum, ctx.SelectedObjIndex, delta));
                    hasChange = true;
                }
                if (MathF.Abs(Quaternion.Dot(stab.Orientation, _gizmoOrigRot)) < 0.9999f) {
                    var newRot = stab.Orientation;
                    stab.Orientation = _gizmoOrigRot;
                    composite.Add(new SetObjectOrientationCommand(ctx.SelectedObjCellNum, ctx.SelectedObjIndex, _gizmoOrigRot, newRot));
                    hasChange = true;
                }
            }
            else if (gizmo.Mode == GizmoMode.Rotate) {
                if (MathF.Abs(Quaternion.Dot(stab.Orientation, _gizmoOrigRot)) < 0.9999f) {
                    var newRot = stab.Orientation;
                    stab.Orientation = _gizmoOrigRot;
                    composite.Add(new SetObjectOrientationCommand(ctx.SelectedObjCellNum, ctx.SelectedObjIndex, _gizmoOrigRot, newRot));
                    hasChange = true;
                }
            }

            if (hasChange) {
                ctx.CommandHistory.Execute(composite, ctx.Document);
                ctx.Document.MarkDirty();
                ctx.RefreshRendering();
                ctx.NotifySelectionChanged();
            }
        }

        private void CancelGizmoDrag(DungeonEditingContext ctx) {
            if (ctx.Document == null) return;
            var cell = ctx.Document.GetCell(ctx.SelectedObjCellNum);
            if (cell == null || ctx.SelectedObjIndex >= cell.StaticObjects.Count) return;
            cell.StaticObjects[ctx.SelectedObjIndex].Origin = _gizmoOrigPos;
            cell.StaticObjects[ctx.SelectedObjIndex].Orientation = _gizmoOrigRot;
            ctx.RefreshRendering();
        }

        private static float ExtractYaw(Quaternion q) {
            float siny = 2.0f * (q.W * q.Z + q.X * q.Y);
            float cosy = 1.0f - 2.0f * (q.Y * q.Y + q.Z * q.Z);
            return MathF.Atan2(siny, cosy);
        }

        private bool IsInsideAnyCell(Vector3 worldPos, DungeonEditingContext ctx) {
            if (ctx.Document == null || ctx.Scene?.EnvCellManager == null) return false;
            var cells = ctx.Scene.EnvCellManager.GetLoadedCellsForLandblock(ctx.Document.LandblockKey);
            if (cells == null) return false;

            const float margin = 2f;
            foreach (var cell in cells) {
                var localPos = Vector3.Transform(worldPos, cell.InverseWorldTransform);
                if (localPos.X >= cell.LocalBoundsMin.X - margin && localPos.X <= cell.LocalBoundsMax.X + margin &&
                    localPos.Y >= cell.LocalBoundsMin.Y - margin && localPos.Y <= cell.LocalBoundsMax.Y + margin &&
                    localPos.Z >= cell.LocalBoundsMin.Z - margin && localPos.Z <= cell.LocalBoundsMax.Z + margin) {
                    return true;
                }
            }
            return false;
        }

        private static Vector2 ProjectToScreen(Vector3 worldPos, DungeonEditingContext ctx) {
            var camera = ctx.Scene?.Camera;
            if (camera == null) return new Vector2(-1, -1);

            var view = camera.GetViewMatrix();
            var proj = camera.GetProjectionMatrix();
            var vp = view * proj;
            var clip = Vector4.Transform(new Vector4(worldPos, 1f), vp);
            if (clip.W <= 0) return new Vector2(-1, -1);

            float ndcX = clip.X / clip.W;
            float ndcY = clip.Y / clip.W;
            float screenX = (ndcX + 1f) * 0.5f * camera.ScreenSize.X;
            float screenY = (ndcY + 1f) * 0.5f * camera.ScreenSize.Y;
            return new Vector2(screenX, screenY);
        }
    }
}
