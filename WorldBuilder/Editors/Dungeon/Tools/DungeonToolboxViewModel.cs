using CommunityToolkit.Mvvm.Input;
using System.Collections.ObjectModel;
using WorldBuilder.ViewModels;

namespace WorldBuilder.Editors.Dungeon.Tools {

    /// <summary>
    /// ViewModel for the dungeon toolbox panel. Wraps the editor VM's tool state
    /// and forwards selection commands. Matches landscape's ToolboxViewModel pattern.
    /// </summary>
    public partial class DungeonToolboxViewModel : ViewModelBase {
        private readonly DungeonEditorViewModel _editor;

        public ObservableCollection<DungeonToolBase> Tools => _editor.Tools;
        public DungeonToolBase? SelectedTool => _editor.SelectedTool;
        public DungeonSubToolBase? SelectedSubTool => _editor.SelectedSubTool;

        public IRelayCommand SelectToolCommand => _editor.SelectToolCommand;
        public IRelayCommand SelectSubToolCommand => _editor.SelectSubToolCommand;

        public DungeonToolboxViewModel(DungeonEditorViewModel editor) {
            _editor = editor;
            _editor.PropertyChanged += (s, e) => {
                if (e.PropertyName == nameof(DungeonEditorViewModel.SelectedTool))
                    OnPropertyChanged(nameof(SelectedTool));
                if (e.PropertyName == nameof(DungeonEditorViewModel.SelectedSubTool))
                    OnPropertyChanged(nameof(SelectedSubTool));
            };
        }
    }
}
