using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Collections.Generic;
using System.Numerics;
using WorldBuilder.Editors.Landscape.Commands;
using WorldBuilder.Lib;
using WorldBuilder.Lib.History;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Editors.Landscape.ViewModels {
    public partial class HeightRaiseLowerSubToolViewModel : SubToolViewModelBase {
        public override string Name => "Raise / Lower";
        public override string IconGlyph => "↕️";

        [ObservableProperty]
        private float _brushRadius = 5f;

        [ObservableProperty]
        private int _strength = 5;

        private bool _isPainting;
        private bool _isLowering;
        private TerrainRaycast.TerrainRaycastHit _currentHitPosition;
        private TerrainRaycast.TerrainRaycastHit _lastHitPosition;
        private readonly CommandHistory _commandHistory;
        private readonly Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> _pendingChanges;
        private readonly Dictionary<ushort, HashSet<int>> _processedVertices;

        public HeightRaiseLowerSubToolViewModel(TerrainEditingContext context, CommandHistory commandHistory) : base(context) {
            _commandHistory = commandHistory ?? throw new ArgumentNullException(nameof(commandHistory));
            _pendingChanges = new Dictionary<ushort, List<(int, byte, byte)>>();
            _processedVertices = new Dictionary<ushort, HashSet<int>>();
        }

        partial void OnBrushRadiusChanged(float value) {
            if (value < 0.5f) BrushRadius = 0.5f;
            if (value > 200f) BrushRadius = 200f;
        }

        partial void OnStrengthChanged(int value) {
            if (value < 1) Strength = 1;
            if (value > 50) Strength = 50;
        }

        public override void OnActivated() {
            Context.ActiveVertices.Clear();
            Context.BrushActive = true;
            Context.BrushRadius = BrushRadius;
            _lastHitPosition = _currentHitPosition = new TerrainRaycast.TerrainRaycastHit();
            _pendingChanges.Clear();
            _processedVertices.Clear();
        }

        public override void OnDeactivated() {
            Context.BrushActive = false;
            Context.ActiveVertices.Clear();
            if (_isPainting) {
                FinalizePainting();
            }
        }

        public override void Update(double deltaTime) {
            Context.BrushCenter = new Vector2(_currentHitPosition.NearestVertice.X, _currentHitPosition.NearestVertice.Y);
            Context.BrushRadius = BrushRadius;
            _lastHitPosition = _currentHitPosition;
        }

        public override bool HandleMouseUp(MouseState mouseState) {
            if (_isPainting && !mouseState.LeftPressed) {
                _isPainting = false;
                FinalizePainting();
                return true;
            }
            return false;
        }

        public override bool HandleMouseMove(MouseState mouseState) {
            if (!mouseState.IsOverTerrain || !mouseState.TerrainHit.HasValue) return false;

            var hitResult = mouseState.TerrainHit.Value;
            _currentHitPosition = hitResult;

            if (_isPainting) {
                ApplyPreviewChanges(hitResult.NearestVertice);
                return true;
            }

            return false;
        }

        public override bool HandleMouseDown(MouseState mouseState) {
            if (!mouseState.IsOverTerrain || !mouseState.TerrainHit.HasValue || !mouseState.LeftPressed) return false;

            _isPainting = true;
            _isLowering = mouseState.ShiftPressed;
            _pendingChanges.Clear();
            _processedVertices.Clear();
            var hitResult = mouseState.TerrainHit.Value;
            ApplyPreviewChanges(hitResult.NearestVertice);

            return true;
        }

        private void ApplyPreviewChanges(Vector3 centerPosition) {
            var terrainService = Context.TerrainSystem.Services.GetRequiredService<ITerrainService>();
            var heightTable = Context.TerrainSystem.Region.LandDefs.LandHeightTable;
            var changes = terrainService.RaiseLowerHeight(
                Context.TerrainSystem.TerrainDoc,
                Context.TerrainSystem.DocumentManager,
                heightTable,
                centerPosition, BrushRadius, Strength, _isLowering,
                _processedVertices, _pendingChanges);

            var batchChanges = new Dictionary<ushort, Dictionary<byte, uint>>();

            foreach (var (lbId, changeList) in changes) {
                if (!_pendingChanges.TryGetValue(lbId, out var list)) {
                    list = new List<(int, byte, byte)>();
                    _pendingChanges[lbId] = list;
                }

                if (!batchChanges.TryGetValue(lbId, out var lbChanges)) {
                    lbChanges = new Dictionary<byte, uint>();
                    batchChanges[lbId] = lbChanges;
                }

                foreach (var change in changeList) {
                    list.Add((change.VertexIndex, change.OriginalValue, change.NewValue));
                    lbChanges[(byte)change.VertexIndex] = change.NewEntryValue;
                }
            }

            if (batchChanges.Count > 0) {
                var modifiedLandblocks = Context.TerrainSystem.UpdateLandblocksBatch(TerrainField.Height, batchChanges);
                Context.MarkLandblocksModified(modifiedLandblocks);
            }
        }

        private void FinalizePainting() {
            if (_pendingChanges.Count == 0) return;

            var description = _isLowering ? "Lower terrain" : "Raise terrain";
            var command = new HeightChangeCommand(Context, description, _pendingChanges);
            _commandHistory.ExecuteCommand(command);

            _pendingChanges.Clear();
            _processedVertices.Clear();
        }
    }
}
