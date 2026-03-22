using Avalonia.Input;
using CommunityToolkit.Mvvm.ComponentModel;
using System.Collections.ObjectModel;
using WorldBuilder.Lib;

namespace WorldBuilder.Editors.Landscape.ViewModels {
    public partial class SelectorToolViewModel : ToolViewModelBase {
        public override string Name => "Select";
        public override string IconGlyph => "🎯";

        private readonly TerrainEditingContext _context;

        [ObservableProperty]
        private ObservableCollection<SubToolViewModelBase> _subTools = new();

        public override ObservableCollection<SubToolViewModelBase> AllSubTools => SubTools;

        public SelectorToolViewModel(
            TerrainEditingContext context,
            SelectSubToolViewModel selectSubTool,
            MoveObjectSubToolViewModel moveSubTool,
            RotateObjectSubToolViewModel rotateSubTool,
            CloneSubToolViewModel cloneSubTool,
            PasteSubToolViewModel pasteSubTool) {
            _context = context;
            SubTools.Add(selectSubTool);
            SubTools.Add(moveSubTool);
            SubTools.Add(rotateSubTool);
            SubTools.Add(cloneSubTool);
            SubTools.Add(pasteSubTool);
        }

        public override void OnActivated() {
            SelectedSubTool?.OnActivated();
        }

        public override void OnDeactivated() {
            // Clear placement mode when switching away from the selector tool
            _context.ObjectSelection.IsPlacementMode = false;
            _context.ObjectSelection.PlacementPreview = null;
            SelectedSubTool?.OnDeactivated();
        }

        public override bool HandleMouseDown(MouseState mouseState) {
            return SelectedSubTool?.HandleMouseDown(mouseState) ?? false;
        }

        public override bool HandleMouseUp(MouseState mouseState) {
            return SelectedSubTool?.HandleMouseUp(mouseState) ?? false;
        }

        public override bool HandleMouseMove(MouseState mouseState) {
            return SelectedSubTool?.HandleMouseMove(mouseState) ?? false;
        }

        public override bool HandleKeyDown(KeyEventArgs e) {
            return SelectedSubTool?.HandleKeyDown(e) ?? false;
        }

        public override void Update(double deltaTime) {
            SelectedSubTool?.Update(deltaTime);
        }
    }
}
