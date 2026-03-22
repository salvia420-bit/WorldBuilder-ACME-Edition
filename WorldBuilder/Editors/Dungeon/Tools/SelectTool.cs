using Avalonia.Input;
using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Numerics;
using WorldBuilder.Lib;

namespace WorldBuilder.Editors.Dungeon.Tools {

    /// <summary>
    /// Unified select tool: click to select cells/objects, drag to move them.
    /// Ctrl+click for multi-select, drag in empty space for box select.
    /// </summary>
    public class SelectTool : DungeonToolBase {
        public override string Name => "Select";
        public override string IconGlyph => "\u2B9E";

        private static readonly ObservableCollection<DungeonSubToolBase> _empty = new();
        public override ObservableCollection<DungeonSubToolBase> AllSubTools => _empty;

        private readonly DungeonEditingContext _ctx;

        private enum DragMode { None, BoxSelect, MoveCell, MoveObject }
        private DragMode _dragMode;
        private Vector2 _dragScreenStart;
        private Vector3 _dragWorldStart;
        private Vector3 _dragOriginStart;
        private bool _didClickSelect;
        private const float DragThreshold = 4f;
        private bool _dragStarted;

        public SelectTool(DungeonEditingContext ctx) {
            _ctx = ctx;
        }

        public override void OnActivated() { StatusText = ""; }
        public override void OnDeactivated() { _dragMode = DragMode.None; }

        public override bool HandleMouseDown(MouseState mouseState, DungeonEditingContext ctx) {
            if (!mouseState.LeftPressed || mouseState.RightPressed) return false;
            if (ctx.Scene?.EnvCellManager == null || ctx.Document == null) return false;

            var ray = ctx.ComputeRay(mouseState);
            if (ray == null) return false;
            var (origin, dir) = ray.Value;

            _dragScreenStart = mouseState.Position;
            _dragStarted = false;
            _didClickSelect = false;

            // Check for object hit first
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
                    cell.StaticObjects[ctx.SelectedObjIndex].Origin = _dragOriginStart + delta;
                    ctx.RefreshRendering();
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
            if (e.Key == Key.Escape) {
                _dragMode = DragMode.None;
                ctx.SelectedCells.Clear();
                ctx.SelectedCell = null;
                ctx.SelectedObjIndex = -1;
                ctx.NotifySelectionChanged();
                return true;
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
