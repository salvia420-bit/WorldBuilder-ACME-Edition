using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using WorldBuilder.Editors.Landscape.Commands;
using WorldBuilder.Lib;
using WorldBuilder.Lib.History;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Editors.Landscape.ViewModels {
    public partial class HeightSmoothSubToolViewModel : SubToolViewModelBase {
        public override string Name => "Smooth";
        public override string IconGlyph => "🔄";

        [ObservableProperty]
        private float _brushRadius = 5f;

        [ObservableProperty]
        private float _strength = 0.5f;

        private bool _isPainting;
        private TerrainRaycast.TerrainRaycastHit _currentHitPosition;
        private TerrainRaycast.TerrainRaycastHit _lastHitPosition;
        private readonly CommandHistory _commandHistory;
        private readonly ITerrainService _terrainService;
        private readonly Dictionary<ushort, List<(int VertexIndex, byte OriginalValue, byte NewValue)>> _pendingChanges;

        public HeightSmoothSubToolViewModel(TerrainEditingContext context, CommandHistory commandHistory, ITerrainService terrainService) : base(context) {
            _commandHistory = commandHistory ?? throw new ArgumentNullException(nameof(commandHistory));
            _terrainService = terrainService ?? throw new ArgumentNullException(nameof(terrainService));
            _pendingChanges = new Dictionary<ushort, List<(int, byte, byte)>>();
        }

        partial void OnBrushRadiusChanged(float value) {
            if (value < 0.5f) BrushRadius = 0.5f;
            if (value > 200f) BrushRadius = 200f;
        }

        partial void OnStrengthChanged(float value) {
            if (value < 0.0f) Strength = 0.0f;
            if (value > 1.0f) Strength = 1.0f;
        }

        public override void OnActivated() {
            Context.ActiveVertices.Clear();
            Context.BrushActive = true;
            Context.BrushRadius = BrushRadius;
            _lastHitPosition = _currentHitPosition = new TerrainRaycast.TerrainRaycastHit();
            _pendingChanges.Clear();
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
            _pendingChanges.Clear();
            var hitResult = mouseState.TerrainHit.Value;
            ApplyPreviewChanges(hitResult.NearestVertice);

            return true;
        }

        private void ApplyPreviewChanges(Vector3 centerPosition) {
            var heightTable = Context.TerrainSystem.Region.LandDefs.LandHeightTable;
            var changes = _terrainService.SmoothTerrain(
                Context.TerrainSystem.TerrainDoc,
                Context.TerrainSystem.DocumentManager,
                heightTable,
                centerPosition, BrushRadius, Strength, _pendingChanges);

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

            var command = new HeightChangeCommand(Context, "Smooth terrain", _pendingChanges);
            _commandHistory.ExecuteCommand(command);

            _pendingChanges.Clear();
        }
    }
}
