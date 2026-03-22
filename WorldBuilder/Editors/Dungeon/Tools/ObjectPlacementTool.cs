using Avalonia.Input;
using CommunityToolkit.Mvvm.ComponentModel;
using System;
using System.Collections.ObjectModel;
using System.Numerics;
using WorldBuilder.Lib;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Editors.Dungeon.Tools {

    /// <summary>
    /// Object placement tool. When an object is selected from the browser,
    /// shows a ghost preview on cell surfaces and places on click.
    /// Stays active for repeated placement.
    /// </summary>
    public partial class ObjectPlacementTool : DungeonToolBase {
        public override string Name => "Place Object";
        public override string IconGlyph => "\u2B22"; // hexagon

        private static readonly ObservableCollection<DungeonSubToolBase> _empty = new();
        public override ObservableCollection<DungeonSubToolBase> AllSubTools => _empty;

        [ObservableProperty] private uint? _pendingObjectId;
        [ObservableProperty] private bool _pendingObjectIsSetup;

        public event Action? CancelRequested;

        public override void OnActivated() {
            UpdateStatus();
        }

        public override void OnDeactivated() {
            _pendingObjectId = null;
            StatusText = "";
        }

        public void SetObject(uint objectId, bool isSetup) {
            PendingObjectId = objectId;
            PendingObjectIsSetup = isSetup;
            UpdateStatus();
        }

        private void UpdateStatus() {
            StatusText = PendingObjectId.HasValue
                ? $"Click cell surface to place 0x{PendingObjectId.Value:X8} — Escape to cancel"
                : "Select an object from the browser";
        }

        public override bool HandleMouseDown(MouseState mouseState, DungeonEditingContext ctx) {
            if (!mouseState.LeftPressed || mouseState.RightPressed) return false;
            if (PendingObjectId == null || ctx.Document == null || ctx.Scene == null) return false;

            var ray = ctx.ComputeRay(mouseState);
            if (ray == null) return false;
            var (origin, dir) = ray.Value;

            var hit = ctx.Raycast(origin, dir);
            if (!hit.Hit) return false;

            var cellNum = (ushort)(hit.Cell.CellId & 0xFFFF);
            var dc = ctx.Document.GetCell(cellNum);
            if (dc == null) return false;

            uint lbId = ctx.Document.LandblockKey;
            var blockX = (lbId >> 8) & 0xFF;
            var blockY = lbId & 0xFF;
            var lbOffset = new Vector3(blockX * 192f, blockY * 192f, 0f);
            var localOrigin = hit.HitPosition - lbOffset;
            localOrigin.Z += 50f;

            var cmd = new AddStaticObjectCommand(cellNum, PendingObjectId.Value, localOrigin, Quaternion.Identity);
            ctx.CommandHistory.Execute(cmd, ctx.Document);
            ctx.Document.MarkDirty();
            ctx.RefreshRendering();
            ctx.SetStatus($"Placed object 0x{PendingObjectId.Value:X8} in room");

            if (ctx.Scene != null) ctx.Scene.PlacementPreview = null;
            return true;
        }

        public override bool HandleMouseUp(MouseState mouseState, DungeonEditingContext ctx) => false;

        public override bool HandleMouseMove(MouseState mouseState, DungeonEditingContext ctx) {
            if (PendingObjectId == null || ctx.Scene == null) return false;

            var ray = ctx.ComputeRay(mouseState);
            if (ray == null) { ctx.Scene.PlacementPreview = null; return false; }
            var (origin, dir) = ray.Value;

            var hit = ctx.Raycast(origin, dir);
            if (hit.Hit) {
                ctx.Scene.PlacementPreview = new Shared.Documents.StaticObject {
                    Id = PendingObjectId.Value,
                    IsSetup = PendingObjectIsSetup,
                    Origin = hit.HitPosition,
                    Orientation = Quaternion.Identity,
                    Scale = Vector3.One
                };
            }
            else {
                ctx.Scene.PlacementPreview = null;
            }
            return false;
        }

        public override bool HandleKeyDown(KeyEventArgs e, DungeonEditingContext ctx) {
            if (e.Key == Key.Escape) {
                if (ctx.Scene != null) ctx.Scene.PlacementPreview = null;
                CancelRequested?.Invoke();
                return true;
            }
            return false;
        }
    }
}
